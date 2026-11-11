import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listFiles, loadOwnedWorkspace, serializeFileMeta, upsertFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const schema = z.object({
  path: z.string().min(1).max(256),
  content: z.string().max(512 * 1024).default(""),
});

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  return json({ files: listFiles(ws.id) });
});

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  const body = await parseBody(req, schema);
  const file = upsertFile(ws.id, body.path, body.content ?? "");
  return json({ file: serializeFileMeta(file) }, { status: 201 });
});
