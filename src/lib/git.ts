import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gitRemotes, type GitRemote } from "@/db/schema";
import { AppError, Errors, sanitizeUpstreamError } from "./errors";
import { safeFetch } from "./http-client";
import { decryptSecret, encryptSecret, last4 } from "./secrets";
import { allFiles, ensureWorkspace } from "./workspace";

export interface GitRemoteInput {
  host?: string;
  owner: string;
  repo: string;
  branch?: string;
  token: string;
}

export function getRemote(projectId: string): GitRemote | null {
  return db.select().from(gitRemotes).where(eq(gitRemotes.projectId, projectId)).get() ?? null;
}

/** Client-safe view of a remote config (never returns the token). */
export function serializeRemote(r: GitRemote) {
  return {
    host: r.host,
    owner: r.owner,
    repo: r.repo,
    branch: r.branch,
    tokenLast4: r.last4 || null,
    lastPushAt: r.lastPushAt,
    lastPushSha: r.lastPushSha,
  };
}

export function setRemote(projectId: string, input: GitRemoteInput, userId: string | null) {
  const host = (input.host || "api.github.com").trim();
  const values = {
    projectId,
    host,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch || "main",
    tokenCiphertext: encryptSecret(input.token),
    last4: last4(input.token),
    createdBy: userId,
    updatedAt: new Date(),
  };
  return db
    .insert(gitRemotes)
    .values(values)
    .onConflictDoUpdate({ target: gitRemotes.projectId, set: values })
    .returning()
    .get();
}

export function deleteRemote(projectId: string): void {
  db.delete(gitRemotes).where(eq(gitRemotes.projectId, projectId)).run();
}

/**
 * Push the project's workspace files to the configured remote as one atomic
 * commit, via the GitHub Git Data API (blobs → tree → commit → ref). No shell,
 * no git binary. The destination host is SSRF-allowlisted to the configured host.
 */
export async function pushWorkspace(
  projectId: string,
  message: string,
  userId: string | null,
): Promise<{ commitSha: string; fileCount: number; branch: string }> {
  const remote = getRemote(projectId);
  if (!remote) throw Errors.badRequest("No Git remote is configured for this project");

  const ws = ensureWorkspace(projectId, userId);
  const files = allFiles(ws.id);
  if (files.length === 0) throw Errors.badRequest("The workspace has no files to push");

  const token = decryptSecret(remote.tokenCiphertext);
  const base = `https://${remote.host.replace(/\/+$/, "")}/repos/${remote.owner}/${remote.repo}`;

  const gh = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const res = await safeFetch(
      `${base}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "xiero-nexus-ai",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          ...(init.headers ?? {}),
        },
      },
      { timeoutMs: 20_000, allowHosts: [remote.host] },
    );
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new AppError(502, "git_error", `GitHub ${path} → ${res.status}: ${sanitizeUpstreamError(detail)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };

  // 1. Current branch head → base commit + tree.
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(remote.branch)}`).catch((e) => {
    throw e instanceof AppError
      ? new AppError(502, "git_error", `Could not read branch "${remote.branch}" (it must already exist): ${e.message}`)
      : e;
  });
  const baseCommitSha = (ref.object as { sha?: string } | undefined)?.sha;
  if (!baseCommitSha) throw new AppError(502, "git_error", "Unexpected ref response from GitHub");
  const baseCommit = await gh(`/git/commits/${baseCommitSha}`);
  const baseTreeSha = (baseCommit.tree as { sha?: string } | undefined)?.sha;

  // 2. Blob per file.
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const f of files) {
    const blob = await gh(`/git/blobs`, { method: "POST", body: JSON.stringify({ content: f.content, encoding: "utf-8" }) });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: String(blob.sha) });
  }

  // 3. Tree → commit → move ref.
  const newTree = await gh(`/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseTreeSha, tree }) });
  const newCommit = await gh(`/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: message || "Update from Xiero Nexus AI", tree: String(newTree.sha), parents: [baseCommitSha] }),
  });
  const commitSha = String(newCommit.sha);
  await gh(`/git/refs/heads/${encodeURIComponent(remote.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commitSha }) });

  db.update(gitRemotes)
    .set({ lastPushAt: new Date(), lastPushSha: commitSha, updatedAt: new Date() })
    .where(eq(gitRemotes.projectId, projectId))
    .run();

  return { commitSha, fileCount: files.length, branch: remote.branch };
}
