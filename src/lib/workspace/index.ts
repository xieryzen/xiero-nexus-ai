import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  execRuns,
  projects,
  workspaceFiles,
  workspaceSnapshots,
  workspaces,
  type ExecRun,
  type User,
  type Workspace,
  type WorkspaceFile,
} from "@/db/schema";
import { Errors } from "@/lib/errors";
import { validateWorkspacePath } from "./paths";

export const FILE_MAX_BYTES = 256 * 1024;

/** Get or create the workspace for a project. */
export function ensureWorkspace(projectId: string, userId: string | null): Workspace {
  const existing = db.select().from(workspaces).where(eq(workspaces.projectId, projectId)).get();
  if (existing) return existing;
  return db
    .insert(workspaces)
    .values({ projectId, name: "workspace", createdBy: userId })
    .returning()
    .get();
}

/** Load a workspace the user may access (project owner or admin), or throw. */
export function loadOwnedWorkspace(workspaceId: string, user: User): Workspace {
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) throw Errors.notFound("Workspace not found");
  if (ws.projectId) {
    const project = db.select().from(projects).where(eq(projects.id, ws.projectId)).get();
    if (project && project.createdBy !== user.id && user.role !== "admin") {
      throw Errors.forbidden();
    }
  } else if (user.role !== "admin") {
    throw Errors.forbidden();
  }
  return ws;
}

export function listFiles(workspaceId: string) {
  return db
    .select({
      id: workspaceFiles.id,
      path: workspaceFiles.path,
      size: workspaceFiles.size,
      updatedAt: workspaceFiles.updatedAt,
    })
    .from(workspaceFiles)
    .where(eq(workspaceFiles.workspaceId, workspaceId))
    .orderBy(asc(workspaceFiles.path))
    .all();
}

export function allFiles(workspaceId: string): WorkspaceFile[] {
  return db.select().from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspaceId)).all();
}

export function upsertFile(workspaceId: string, rawPath: string, content: string): WorkspaceFile {
  const path = validateWorkspacePath(rawPath);
  if (content.length > FILE_MAX_BYTES) {
    throw Errors.badRequest("File is too large (max 256 KB)");
  }
  return db
    .insert(workspaceFiles)
    .values({ workspaceId, path, content, size: content.length })
    .onConflictDoUpdate({
      target: [workspaceFiles.workspaceId, workspaceFiles.path],
      set: { content, size: content.length, updatedAt: new Date() },
    })
    .returning()
    .get();
}

export function getFile(workspaceId: string, fileId: string): WorkspaceFile {
  const f = db
    .select()
    .from(workspaceFiles)
    .where(and(eq(workspaceFiles.id, fileId), eq(workspaceFiles.workspaceId, workspaceId)))
    .get();
  if (!f) throw Errors.notFound("File not found");
  return f;
}

export function deleteFile(workspaceId: string, fileId: string): void {
  getFile(workspaceId, fileId);
  db.delete(workspaceFiles).where(eq(workspaceFiles.id, fileId)).run();
}

export function recordExec(row: Omit<ExecRun, "id" | "createdAt">): ExecRun {
  return db.insert(execRuns).values(row).returning().get();
}

export function listExecRuns(workspaceId: string, limit = 20) {
  return db
    .select()
    .from(execRuns)
    .where(eq(execRuns.workspaceId, workspaceId))
    .orderBy(asc(execRuns.createdAt))
    .all()
    .slice(-limit)
    .reverse();
}

export function serializeFileMeta(f: { id: string; path: string; size: number; updatedAt: Date }) {
  return { id: f.id, path: f.path, size: f.size, updatedAt: f.updatedAt };
}

// ─── Snapshots (lightweight local version history) ──────────────────────────

interface SnapshotFile {
  path: string;
  content: string;
}

export function createSnapshot(workspaceId: string, message: string, userId: string | null) {
  const files: SnapshotFile[] = allFiles(workspaceId).map((f) => ({ path: f.path, content: f.content }));
  return db
    .insert(workspaceSnapshots)
    .values({
      workspaceId,
      message: message.slice(0, 200),
      files: JSON.stringify(files),
      fileCount: files.length,
      createdBy: userId,
    })
    .returning()
    .get();
}

export function listSnapshots(workspaceId: string) {
  return db
    .select({
      id: workspaceSnapshots.id,
      message: workspaceSnapshots.message,
      fileCount: workspaceSnapshots.fileCount,
      createdAt: workspaceSnapshots.createdAt,
    })
    .from(workspaceSnapshots)
    .where(eq(workspaceSnapshots.workspaceId, workspaceId))
    .all()
    .reverse();
}

export function getSnapshot(workspaceId: string, snapshotId: string) {
  const s = db
    .select()
    .from(workspaceSnapshots)
    .where(and(eq(workspaceSnapshots.id, snapshotId), eq(workspaceSnapshots.workspaceId, workspaceId)))
    .get();
  if (!s) throw Errors.notFound("Snapshot not found");
  const files = JSON.parse(s.files) as SnapshotFile[];
  return { id: s.id, message: s.message, fileCount: s.fileCount, createdAt: s.createdAt, files };
}

/** Replace the workspace's files with those from a snapshot. */
export function restoreSnapshot(workspaceId: string, snapshotId: string): number {
  const snap = getSnapshot(workspaceId, snapshotId);
  return db.transaction((tx) => {
    tx.delete(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspaceId)).run();
    let restored = 0;
    for (const f of snap.files) {
      let path: string;
      try {
        path = validateWorkspacePath(f.path);
      } catch {
        continue; // skip anything that isn't a safe path
      }
      const content = String(f.content ?? "");
      tx.insert(workspaceFiles)
        .values({ workspaceId, path, content, size: content.length })
        .onConflictDoUpdate({
          target: [workspaceFiles.workspaceId, workspaceFiles.path],
          set: { content, size: content.length, updatedAt: new Date() },
        })
        .run();
      restored++;
    }
    return restored;
  });
}

export function latestExecSummary(workspaceId: string, n = 3): string {
  const runs = listExecRuns(workspaceId, n);
  if (runs.length === 0) return "";
  return runs
    .map((r) => `$ ${r.command}\n[exit ${r.exitCode ?? r.status}] ${(r.stdout || r.stderr || "").slice(0, 600)}`)
    .join("\n\n");
}
