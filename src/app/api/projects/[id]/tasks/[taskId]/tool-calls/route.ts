import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { toolCalls } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";

export const dynamic = "force-dynamic";

/** The tool calls an agent made while it worked on a task, in order. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const rows = db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.projectId, project.id), eq(toolCalls.taskId, params.taskId!)))
    .orderBy(asc(toolCalls.createdAt), asc(toolCalls.step))
    .limit(400)
    .all();
  return json({
    calls: rows.map((c) => ({
      id: c.id,
      step: c.step,
      name: c.name,
      arguments: c.arguments,
      result: c.result,
      isError: c.isError,
      durationMs: c.durationMs,
      createdAt: c.createdAt.getTime(),
    })),
  });
});
