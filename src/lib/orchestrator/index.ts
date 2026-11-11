import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  agentRuns,
  agents as agentsTable,
  modelCapabilities,
  models,
  projects,
  projectTasks,
  providers,
  teamAgents,
  workflows,
  type Agent,
  type Project,
  PROJECT_STATES,
  TASK_STATES,
} from "@/db/schema";
import type { ChatMessage } from "@/lib/adapters/types";
import { adapterIsImplemented } from "@/lib/adapters";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import { gatewayChat, resolveEnabledModel, type ResolvedModel } from "@/lib/gateway";
import { computeCost, estimateTokens, recordUsage } from "@/lib/usage";
import { ensureWorkspace, latestExecSummary, upsertFile } from "@/lib/workspace";
import { pickCheapestModel, type RoutableModel } from "@/lib/router";
import { parsePlan, parseVerdict } from "./plan";

type ProjectState = (typeof PROJECT_STATES)[number];
type TaskState = (typeof TASK_STATES)[number];

// Hard ceilings regardless of per-project settings.
const MAX_TASKS_CEIL = 20;

export type RunEvent =
  | { type: "status"; status: ProjectState }
  | {
      type: "plan";
      tasks: { seq: number; title: string; agent: string; dependsOn: number[] }[];
    }
  | {
      type: "task";
      seq: number;
      title: string;
      status: TaskState;
      agent: string | null;
      artifact?: string | null;
      error?: string | null;
      tokens?: number;
    }
  | { type: "final"; deliverable: string }
  | { type: "review"; notes: string }
  | { type: "budget"; used: number; limit: number }
  | { type: "error"; message: string }
  | { type: "done"; status: ProjectState };

// Cooperative cancellation across requests (single process).
const cancelled = new Set<string>();
export function requestCancel(projectId: string): void {
  cancelled.add(projectId);
}

function agentsForProject(project: Project): Agent[] {
  if (project.teamId) {
    const ids = db
      .select({ agentId: teamAgents.agentId })
      .from(teamAgents)
      .where(eq(teamAgents.teamId, project.teamId))
      .all()
      .map((r) => r.agentId);
    if (ids.length === 0) return [];
    return db
      .select()
      .from(agentsTable)
      .where(inArray(agentsTable.id, ids))
      .all()
      .filter((a) => a.status === "active");
  }
  return db.select().from(agentsTable).where(eq(agentsTable.status, "active")).all();
}

function describeAgents(list: Agent[]): string {
  return list
    .map((a) => `- ${a.name} (${a.role})${a.instructions ? `: ${a.instructions.slice(0, 160)}` : ""}`)
    .join("\n");
}

async function invoke(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  temperature: number,
): Promise<{ content: string; prompt: number; completion: number }> {
  const r = await gatewayChat(resolved, messages, { temperature });
  const prompt = r.usage?.promptTokens ?? estimateTokens(messages.map((m) => m.content).join("\n"));
  const completion = r.usage?.completionTokens ?? estimateTokens(r.content);
  return { content: r.content, prompt, completion };
}

/** Enabled models (on enabled, implemented-adapter providers) with prices + caps. */
function loadRoutableModels(): RoutableModel[] {
  const rows = db
    .select({
      id: models.id,
      inputPricePerMTok: models.inputPricePerMTok,
      outputPricePerMTok: models.outputPricePerMTok,
      adapter: providers.adapter,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(models.enabled, true))
    .all()
    .filter((m) => adapterIsImplemented(m.adapter));
  if (rows.length === 0) return [];
  const caps = new Map<string, string[]>();
  for (const c of db.select().from(modelCapabilities).all()) {
    const list = caps.get(c.modelRowId) ?? [];
    list.push(c.capability);
    caps.set(c.modelRowId, list);
  }
  return rows.map((m) => ({
    id: m.id,
    inputPricePerMTok: m.inputPricePerMTok,
    outputPricePerMTok: m.outputPricePerMTok,
    capabilities: caps.get(m.id) ?? [],
  }));
}

/** Ordered model candidates for an agent: auto-routed pick first (if enabled),
 * then the agent's explicit primary/fallback, then the project manager model. */
function buildCandidates(
  agent: Agent | undefined,
  project: Project,
  routable: RoutableModel[],
): string[] {
  const ids: (string | null | undefined)[] = [];
  if (agent?.routingMode === "auto") {
    ids.push(pickCheapestModel(routable, agent.requiredCapability ?? undefined));
  }
  ids.push(agent?.primaryModelRowId, agent?.fallbackModelRowId, project.managerModelRowId);
  return [...new Set(ids.filter((x): x is string => Boolean(x)))];
}

/**
 * Plan and execute a project. Emits events for the API to stream.
 * Agents reason and produce written artifacts via the gateway; this phase does
 * NOT execute code or tools (that is the v1.2 sandbox).
 */
export async function runProject(
  projectId: string,
  emit: (e: RunEvent) => void,
): Promise<void> {
  cancelled.delete(projectId);
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    emit({ type: "error", message: "Project not found" });
    return;
  }

  const setStatus = (status: ProjectState, extra: Partial<Project> = {}) => {
    db.update(projects)
      .set({ status, updatedAt: new Date(), ...extra })
      .where(eq(projects.id, projectId))
      .run();
    emit({ type: "status", status });
  };

  const fail = (message: string) => {
    setStatus("failed", { error: message, finishedAt: new Date() });
    emit({ type: "error", message });
    emit({ type: "done", status: "failed" });
  };

  try {
    // Manager model
    let manager: ResolvedModel;
    try {
      if (!project.managerModelRowId) throw new AppError(400, "no_model", "No manager model set");
      manager = resolveEnabledModel(project.managerModelRowId);
    } catch (e) {
      return fail(e instanceof AppError ? e.message : "Manager model unavailable");
    }

    const routable = loadRoutableModels();
    const workforce = agentsForProject(project).filter(
      (a) => buildCandidates(a, project, routable).length > 0,
    );
    if (workforce.length === 0) {
      return fail("No usable agents (each agent needs a model, auto-routing, or a project manager model).");
    }

    // ── Approval gate (v1.3) ────────────────────────────────────────────────
    if (project.requiresApproval && !project.approved) {
      db.update(projects)
        .set({ status: "needs_approval", updatedAt: new Date() })
        .where(eq(projects.id, projectId))
        .run();
      emit({ type: "status", status: "needs_approval" });
      emit({ type: "done", status: "needs_approval" });
      return;
    }
    // Consume a one-time approval so each run must be approved afresh.
    if (project.requiresApproval && project.approved) {
      db.update(projects).set({ approved: false }).where(eq(projects.id, projectId)).run();
    }

    // Clear any previous run.
    db.delete(agentRuns).where(eq(agentRuns.projectId, projectId)).run();
    db.delete(projectTasks).where(eq(projectTasks.projectId, projectId)).run();

    setStatus("planning", { startedAt: new Date(), error: null, finalDeliverable: null });

    // ── Plan ──────────────────────────────────────────────────────────────
    const taskCap = Math.min(project.maxTasks, MAX_TASKS_CEIL);
    let plan;

    if (project.workflowId) {
      // Deterministic plan from a saved workflow (no AI-Manager planning).
      const wf = db.select().from(workflows).where(eq(workflows.id, project.workflowId)).get();
      if (!wf) return fail("The selected workflow no longer exists");
      let steps: unknown;
      try {
        steps = JSON.parse(wf.steps);
      } catch {
        steps = [];
      }
      const arr = Array.isArray(steps) ? steps : [];
      const tasks = arr.map((s, i) => {
        const step = s as Record<string, unknown>;
        return {
          seq: Number(step.seq) || i + 1,
          title: String(step.title || `Step ${i + 1}`),
          objective: String(step.objective || step.title || ""),
          acceptanceCriteria: String(step.acceptanceCriteria || ""),
          agent: String(step.role || step.agent || ""),
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(Number) : [],
          outputFile: step.outputFile ? String(step.outputFile) : undefined,
        };
      });
      plan = parsePlan(JSON.stringify({ tasks }), taskCap);
      if (!plan.ok || plan.tasks.length === 0) {
        return fail(`Workflow is invalid: ${plan.error ?? "no steps"}`);
      }
    } else {
      const planMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are the AI Manager of an engineering team. Decompose the user's goal into a " +
            "small set of concrete tasks (3–8), each assigned to one available agent by name. " +
            "Respond with ONLY a JSON object, no prose, of the form: " +
            '{"tasks":[{"seq":1,"title":"...","objective":"...","acceptanceCriteria":"...","agent":"<agent name>","dependsOn":[],"outputFile":"src/file.ts"}]}. ' +
            "dependsOn lists seq numbers of earlier tasks this one needs. For a task whose deliverable is a file " +
            '(code/config), add an "outputFile" relative path and the agent should return ONLY that file\'s contents; ' +
            "its artifact is saved to the project workspace. Keep it minimal and ordered.\n\n" +
            `Available agents:\n${describeAgents(workforce)}`,
        },
        { role: "user", content: `Goal:\n${project.goal}` },
      ];

      plan = parsePlan((await invoke(manager, planMessages, 0.2).then((r) => r.content)) ?? "", taskCap);
      if (!plan.ok) {
        const retry = await invoke(
          manager,
          [...planMessages, { role: "user", content: "Your previous answer was not valid JSON. Respond with ONLY the JSON object." }],
          0,
        );
        plan = parsePlan(retry.content, taskCap);
      }
      if (!plan.ok || plan.tasks.length === 0) {
        return fail(`Planning failed: ${plan.error ?? "no tasks produced"}`);
      }
    }

    // Map plan agent names → agents (case-insensitive; fall back to first).
    const byName = new Map(workforce.map((a) => [a.name.toLowerCase(), a] as const));
    const resolvedAgentFor = (name: string): Agent =>
      byName.get(name.toLowerCase()) ??
      workforce.find((a) => a.role.toLowerCase() === name.toLowerCase()) ??
      workforce[0]!;

    // Persist tasks.
    const taskRows = plan.tasks.map((t) => {
      const agent = resolvedAgentFor(t.agent);
      return db
        .insert(projectTasks)
        .values({
          projectId,
          seq: t.seq,
          title: t.title,
          objective: t.objective,
          acceptanceCriteria: t.acceptanceCriteria || null,
          agentId: agent.id,
          dependsOn: JSON.stringify(t.dependsOn),
          status: "queued",
        })
        .returning()
        .get();
    });

    emit({
      type: "plan",
      tasks: plan.tasks.map((t) => ({
        seq: t.seq,
        title: t.title,
        agent: resolvedAgentFor(t.agent).name,
        dependsOn: t.dependsOn,
      })),
    });

    setStatus("running");
    const workspace = ensureWorkspace(projectId, project.createdBy);

    // ── Execute ─────────────────────────────────────────────────────────────
    const bySeq = new Map(taskRows.map((t) => [t.seq, t] as const));
    const planBySeq = new Map(plan.tasks.map((t) => [t.seq, t] as const));
    const statusBySeq = new Map<number, TaskState>();
    const agentById = new Map(workforce.map((a) => [a.id, a] as const));
    let usedTokens = 0;
    const budget = project.maxTokens;
    const maxParallel = Math.max(1, project.maxParallel);

    const runTask = async (seq: number): Promise<{ succeeded: boolean; tokens: number }> => {
      const task = bySeq.get(seq)!;
      const planned = planBySeq.get(seq)!;
      const agent = task.agentId ? agentById.get(task.agentId) : undefined;

      db.update(projectTasks).set({ status: "running", updatedAt: new Date() }).where(eq(projectTasks.id, task.id)).run();
      emit({ type: "task", seq, title: task.title, status: "running", agent: agent?.name ?? null });

      const depContext = planned.dependsOn
        .map((d) => {
          const dt = bySeq.get(d);
          return dt?.artifact ? `### Output of task ${d} (${dt.title})\n${dt.artifact}` : "";
        })
        .filter(Boolean)
        .join("\n\n");

      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            `You are ${agent?.name ?? "an agent"}, acting as ${agent?.role ?? "a specialist"}.\n` +
            `${agent?.instructions ?? ""}\n\n` +
            `Overall project goal: ${project.goal}\n` +
            `Complete your assigned task and return only the deliverable for it.` +
            (task.acceptanceCriteria ? `\nAcceptance criteria: ${task.acceptanceCriteria}` : ""),
        },
        {
          role: "user",
          content:
            `Task: ${task.title}\n\n${task.objective}` +
            (depContext ? `\n\nRelevant prior work:\n${depContext}` : ""),
        },
      ];

      const candidates = buildCandidates(agent, project, routable);
      let succeeded = false;
      let lastError = "No model available";
      let attempt = 0;
      let taskTokens = 0;

      for (const mid of candidates) {
        attempt++;
        let resolved: ResolvedModel;
        try {
          resolved = resolveEnabledModel(mid);
        } catch (e) {
          lastError = e instanceof AppError ? e.message : "Model unavailable";
          db.insert(agentRuns).values({ projectId, taskId: task.id, agentId: agent?.id ?? null, modelRowId: mid, status: "error", attempt, error: lastError }).run();
          continue;
        }
        const started = Date.now();
        try {
          const r = await invoke(resolved, messages, agent?.temperature ?? 0.7);
          const latencyMs = Date.now() - started;
          taskTokens = r.prompt + r.completion;
          db.insert(agentRuns).values({
            projectId,
            taskId: task.id,
            agentId: agent?.id ?? null,
            modelRowId: resolved.model.id,
            status: "ok",
            attempt,
            promptTokens: r.prompt,
            completionTokens: r.completion,
            latencyMs,
          }).run();
          recordUsage({
            userId: project.createdBy,
            providerId: resolved.provider.id,
            modelRowId: resolved.model.id,
            kind: "other",
            promptTokens: r.prompt,
            completionTokens: r.completion,
            estimatedCost: computeCost(resolved.model, r.prompt, r.completion),
            status: "ok",
            latencyMs,
          });
          db.update(projectTasks).set({
            status: "succeeded",
            artifact: r.content,
            attempts: attempt,
            promptTokens: r.prompt,
            completionTokens: r.completion,
            updatedAt: new Date(),
          }).where(eq(projectTasks.id, task.id)).run();
          if (planned.outputFile) {
            try {
              upsertFile(workspace.id, planned.outputFile, r.content);
            } catch {
              /* invalid path from the model — skip the file write, keep the artifact */
            }
          }
          emit({ type: "task", seq, title: task.title, status: "succeeded", agent: agent?.name ?? null, artifact: r.content, tokens: taskTokens });
          succeeded = true;
          break;
        } catch (e) {
          lastError = e instanceof AppError ? e.message : sanitizeUpstreamError(e);
          db.insert(agentRuns).values({ projectId, taskId: task.id, agentId: agent?.id ?? null, modelRowId: resolved.model.id, status: "error", attempt, latencyMs: Date.now() - started, error: lastError }).run();
        }
      }

      if (!succeeded) {
        db.update(projectTasks).set({ status: "failed", error: lastError, attempts: attempt, updatedAt: new Date() }).where(eq(projectTasks.id, task.id)).run();
        emit({ type: "task", seq, title: task.title, status: "failed", agent: agent?.name ?? null, error: lastError });
      }
      return { succeeded, tokens: taskTokens };
    };

    // Execute independent tasks in dependency-ordered waves (parallel within a wave).
    const pending = new Set(plan.tasks.map((t) => t.seq));
    const markAll = (seqs: Iterable<number>, status: TaskState, error?: string) => {
      for (const seq of seqs) {
        const task = bySeq.get(seq)!;
        const agent = task.agentId ? agentById.get(task.agentId) : undefined;
        db.update(projectTasks).set({ status, updatedAt: new Date() }).where(eq(projectTasks.id, task.id)).run();
        emit({ type: "task", seq, title: task.title, status, agent: agent?.name ?? null, error });
        statusBySeq.set(seq, status);
      }
    };

    while (pending.size > 0) {
      if (cancelled.has(projectId)) {
        markAll(pending, "cancelled");
        pending.clear();
        break;
      }
      if (usedTokens > budget) {
        markAll(pending, "cancelled", "Token budget exhausted");
        pending.clear();
        break;
      }
      const ready = [...pending]
        .filter((seq) => planBySeq.get(seq)!.dependsOn.every((d) => statusBySeq.get(d) === "succeeded"))
        .sort((a, b) => a - b);
      if (ready.length === 0) {
        markAll(pending, "blocked", "A dependency did not succeed");
        pending.clear();
        break;
      }
      const batch = ready.slice(0, maxParallel);
      const results = await Promise.all(batch.map((seq) => runTask(seq)));
      batch.forEach((seq, i) => {
        const res = results[i]!;
        statusBySeq.set(seq, res.succeeded ? "succeeded" : "failed");
        usedTokens += res.tokens;
        pending.delete(seq);
      });
      emit({ type: "budget", used: usedTokens, limit: budget });
    }

    db.update(projects).set({ tokensUsed: usedTokens, updatedAt: new Date() }).where(eq(projects.id, projectId)).run();

    if (cancelled.has(projectId)) {
      setStatus("cancelled", { finishedAt: new Date() });
      emit({ type: "done", status: "cancelled" });
      return;
    }

    // ── Synthesis ─────────────────────────────────────────────────────────
    const completed = db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.projectId, projectId))
      .orderBy(asc(projectTasks.seq))
      .all();
    const succeededTasks = completed.filter((t) => t.status === "succeeded");

    let deliverable = "";
    if (succeededTasks.length > 0) {
      const synthMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are the AI Manager. Consolidate the team's task outputs into a single, " +
            "well-structured final deliverable for the user. At the end, briefly note whether each " +
            "task's acceptance criteria appear met — state clearly that this is your assessment, not " +
            "automated verification.",
        },
        {
          role: "user",
          content:
            `Goal:\n${project.goal}\n\nTask outputs:\n` +
            succeededTasks.map((t) => `## ${t.seq}. ${t.title}\n${t.artifact ?? ""}`).join("\n\n"),
        },
      ];
      try {
        deliverable = (await invoke(manager, synthMessages, 0.3)).content;
      } catch (e) {
        deliverable = `(Synthesis step failed: ${e instanceof AppError ? e.message : "error"})`;
      }
    }

    // ── QA / Security review ──────────────────────────────────────────────
    let reviewNotes = "";
    if (succeededTasks.length > 0) {
      const reviewer = workforce.find(
        (a) => /qa|quality|security|review|test/i.test(a.role) && buildCandidates(a, project, routable).length > 0,
      );
      const reviewModelId = reviewer ? buildCandidates(reviewer, project, routable)[0]! : project.managerModelRowId;
      if (reviewModelId) {
        try {
          const reviewModel = resolveEnabledModel(reviewModelId);
          const execSummary = latestExecSummary(workspace.id);
          const reviewMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                "You are a QA/Security reviewer. For each task, assess whether its deliverable meets the " +
                "acceptance criteria, and flag correctness, security, and missing-requirement concerns. Be " +
                "concise and specific. Where sandbox execution output is provided, ground your judgment in it. " +
                "End with a line exactly 'VERDICT: pass', 'VERDICT: concerns', or 'VERDICT: fail'.",
            },
            {
              role: "user",
              content:
                succeededTasks
                  .map(
                    (t) =>
                      `## ${t.seq}. ${t.title}\nAcceptance criteria: ${t.acceptanceCriteria ?? "(none)"}\nDeliverable:\n${(t.artifact ?? "").slice(0, 2000)}`,
                  )
                  .join("\n\n") + (execSummary ? `\n\n### Sandbox execution results\n${execSummary}` : ""),
            },
          ];
          reviewNotes = (await invoke(reviewModel, reviewMessages, 0.2)).content;
        } catch {
          reviewNotes = "";
        }
      }
    }

    const anyIncomplete = completed.some(
      (t) => t.status === "failed" || t.status === "blocked" || t.status === "cancelled",
    );
    // Hard QA gate: a non-pass verdict blocks a project from reporting success.
    const verdict = reviewNotes ? parseVerdict(reviewNotes) : null;
    const gateFailed = project.hardQaGate && verdict !== null && verdict !== "pass";
    const finalStatus: ProjectState =
      succeededTasks.length === 0
        ? "failed"
        : anyIncomplete || gateFailed
          ? "review"
          : "succeeded";

    db.update(projects)
      .set({
        status: finalStatus,
        finalDeliverable: deliverable || null,
        reviewNotes: reviewNotes || null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .run();

    if (deliverable) emit({ type: "final", deliverable });
    if (reviewNotes) emit({ type: "review", notes: reviewNotes });
    emit({ type: "status", status: finalStatus });
    emit({ type: "done", status: finalStatus });
  } catch (err) {
    fail(err instanceof AppError ? err.message : "Orchestration error");
  } finally {
    cancelled.delete(projectId);
  }
}
