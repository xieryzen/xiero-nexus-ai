import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { allFiles, loadOwnedWorkspace, recordExec } from "@/lib/workspace";
import { getExecutor } from "@/lib/workspace/executor";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const schema = z.object({
  command: z.string().trim().min(1).max(2000),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
});

const CLIENT_ERRORS = new Set(["execution_disabled", "command_not_allowed", "invalid_command"]);

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const ws = loadOwnedWorkspace(params.id!, user);
  const body = await parseBody(req, schema);

  const executor = getExecutor();
  const files = allFiles(ws.id).map((f) => ({ path: f.path, content: f.content }));
  const timeoutMs = body.timeoutMs ?? 60_000;

  try {
    const result = await executor.run({ files, command: body.command, timeoutMs });
    const status = result.exitCode === 0 ? "ok" : "error";
    recordExec({
      workspaceId: ws.id,
      command: body.command,
      status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      createdBy: user.id,
    });
    audit({
      actorUserId: user.id,
      action: "workspace.exec",
      targetType: "workspace",
      targetId: ws.id,
      metadata: { command: body.command, exitCode: result.exitCode },
      ip,
      userAgent,
    });
    return json({ ok: result.exitCode === 0, status, ...result });
  } catch (err) {
    if (err instanceof AppError && CLIENT_ERRORS.has(err.code)) throw err; // 4xx, no record
    const message = err instanceof AppError ? err.message : "Execution failed";
    recordExec({
      workspaceId: ws.id,
      command: body.command,
      status: "error",
      exitCode: null,
      stdout: null,
      stderr: message,
      durationMs: null,
      createdBy: user.id,
    });
    throw err;
  }
});
