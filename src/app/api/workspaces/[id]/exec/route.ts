import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { runAndKeep } from "@/lib/result/build";
import { loadOwnedWorkspace } from "@/lib/workspace";
import { getExecutor } from "@/lib/workspace/executor";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const schema = z.object({
  command: z.string().trim().min(1).max(2000),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
});

/**
 * Run one program on a copy of the workspace's files, in the sandbox runner.
 * The packages it leaves behind (a .jar, an archive) are kept as the
 * project's built files, for an account that may change the project.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const ws = loadOwnedWorkspace(params.id!, user);
  const body = await parseBody(req, schema);

  // Keeping what the program made changes the project: that is for an
  // account that may change it. Anyone else who may open it runs the program
  // and is shown what it printed.
  let keeps = true;
  try {
    loadOwnedWorkspace(ws.id, user, true);
  } catch {
    keeps = false;
  }
  const timeoutMs = Math.min(body.timeoutMs ?? 60_000, getExecutor().maxTimeoutMs);
  const outcome = await runAndKeep({ projectId: keeps ? ws.projectId : null, workspaceId: ws.id, userId: user.id }, body.command, timeoutMs);
  const { result } = outcome;
  audit({
    actorUserId: user.id,
    action: "workspace.exec",
    targetType: "workspace",
    targetId: ws.id,
    metadata: { command: body.command, exitCode: result.exitCode, kept: outcome.kept.map((k) => k.path) },
    ip,
    userAgent,
  });
  return json({
    ok: result.exitCode === 0,
    status: result.exitCode === 0 ? "ok" : "error",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    kept: outcome.kept.map((k) => ({ id: k.id, path: k.path, size: k.sizeBytes })),
    notKept: outcome.refused,
  });
});
