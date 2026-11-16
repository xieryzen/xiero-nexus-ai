import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, agents, models, projectTasks, providers } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { seesSetup } from "@/lib/roles";
import { textFor } from "@/lib/shown";
import { loadOwnedProject } from "@/lib/project-access";

export const dynamic = "force-dynamic";

/**
 * Every attempt of the last run's tasks, in order: which model was asked, how
 * long it took, and what was wrong when it failed. A task shows only its last
 * error; this shows what each model before that one said.
 *
 * Someone who is not shown the setup gets the attempts without the model and
 * the provider, and what went wrong in words that name neither.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const rows = db
    .select({
      id: agentRuns.id,
      taskId: agentRuns.taskId,
      seq: projectTasks.seq,
      title: projectTasks.title,
      agent: agents.name,
      modelId: models.modelId,
      modelName: models.displayName,
      provider: providers.name,
      status: agentRuns.status,
      attempt: agentRuns.attempt,
      latencyMs: agentRuns.latencyMs,
      steps: agentRuns.steps,
      toolCalls: agentRuns.toolCallCount,
      promptTokens: agentRuns.promptTokens,
      completionTokens: agentRuns.completionTokens,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .innerJoin(projectTasks, eq(agentRuns.taskId, projectTasks.id))
    .leftJoin(agents, eq(agentRuns.agentId, agents.id))
    .leftJoin(models, eq(agentRuns.modelRowId, models.id))
    .leftJoin(providers, eq(models.providerId, providers.id))
    .where(eq(agentRuns.projectId, project.id))
    .orderBy(asc(projectTasks.seq), asc(agentRuns.attempt), asc(agentRuns.createdAt))
    .limit(500)
    .all();
  const sees = seesSetup(user.role);
  return json({
    attempts: rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      seq: r.seq,
      title: r.title,
      agent: r.agent,
      model: sees && r.modelId ? r.modelName || r.modelId : null,
      modelId: sees ? r.modelId : null,
      provider: sees ? r.provider : null,
      status: r.status,
      attempt: r.attempt,
      latencyMs: r.latencyMs,
      steps: r.steps,
      toolCalls: r.toolCalls,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      error: textFor(user.role, r.error),
      createdAt: r.createdAt.getTime(),
    })),
  });
});
