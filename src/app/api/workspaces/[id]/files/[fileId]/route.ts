import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { deleteFile, getFile, loadOwnedWorkspace, serializeFileMeta, upsertFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ content: z.string().max(512 * 1024) });

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  const file = getFile(ws.id, params.fileId!);
  return json({ file: { id: file.id, path: file.path, content: file.content, size: file.size, updatedAt: file.updatedAt } });
});

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  const file = getFile(ws.id, params.fileId!);
  const body = await parseBody(req, patchSchema);
  const updated = upsertFile(ws.id, file.path, body.content);
  return json({ file: serializeFileMeta(updated) });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  deleteFile(ws.id, params.fileId!);
  return json({ ok: true });
});
