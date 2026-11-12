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
import { isMediaOnly } from "@/lib/capabilities";
import {
  cleanMediaPrompt,
  mediaArtifact,
  type MediaOptions,
  type TaskKind,
} from "@/lib/creative/prompt";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import { gatewayChat, resolveChatModel, type ResolvedModel } from "@/lib/gateway";
import { serializeAsset, type MediaAssetDTO } from "@/lib/media/dto";
import { generateImages, resolveMediaModel, startVideo, waitForVideo } from "@/lib/media/service";
import { computeCost, estimateTokens, recordUsage } from "@/lib/usage";
import { ensureWorkspace, latestExecSummary, upsertFile } from "@/lib/workspace";
import { pickCheapestModel, type RoutableModel } from "@/lib/router";
import {
  countMediaTasks,
  dependencyContext,
  downgradeUnavailableMedia,
  parsePlan,
  parseVerdict,
} from "./plan";

type ProjectState = (typeof PROJECT_STATES)[number];
type TaskState = (typeof TASK_STATES)[number];

// Hard ceilings regardless of per-project settings.
const MAX_TASKS_CEIL = 20;

/**
 * How long a run waits for one video. Providers take from half a minute to
 * several minutes. When the time is over the task fails, but the video is not
 * lost: it stays in progress and can still finish in Creative Studio.
 */
const VIDEO_WAIT_MS = 15 * 60_000;

export type RunEvent =
  | { type: "status"; status: ProjectState }
  | {
      type: "plan";
      tasks: { seq: number; title: string; agent: string; dependsOn: number[]; kind: TaskKind }[];
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
      /** The image or video an image / video task generated. */
      assets?: MediaAssetDTO[];
    }
  // A running task's progress note. Also keeps the stream alive during a long wait.
  | { type: "progress"; seq: number; message: string }
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

function elapsedLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
  return rows
    .map((m) => ({
      id: m.id,
      inputPricePerMTok: m.inputPricePerMTok,
      outputPricePerMTok: m.outputPricePerMTok,
      capabilities: caps.get(m.id) ?? [],
    }))
    // An image / video model cannot answer a chat request, however cheap it is.
    .filter((m) => !isMediaOnly(m.capabilities));
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
 * NOT execute code or tools (that is the v1.2 sandbox). An image / video task
 * (v1.4) has its agent write a prompt, which the project's image or video
 * model then generates from.
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
      manager = resolveChatModel(project.managerModelRowId);
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

    // The models image / video tasks generate with, when the project has them.
    const mediaModels: Record<"image" | "video", ResolvedModel | null> = { image: null, video: null };
    const mediaProblems: Partial<Record<"image" | "video", string>> = {};
    for (const kind of ["image", "video"] as const) {
      const id = kind === "image" ? project.imageModelRowId : project.videoModelRowId;
      if (!id) continue;
      try {
        mediaModels[kind] = resolveMediaModel(id, kind);
      } catch (e) {
        mediaProblems[kind] = e instanceof AppError ? e.message : "Model unavailable";
      }
    }
    const mediaLimit = Math.max(0, project.maxMedia);

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
          kind: step.kind,
          media: step.media,
        };
      });
      plan = parsePlan(JSON.stringify({ tasks }), taskCap);
      if (!plan.ok || plan.tasks.length === 0) {
        return fail(`Workflow is invalid: ${plan.error ?? "no steps"}`);
      }
      // A workflow's steps are fixed, so stop before anything is spent when it
      // cannot be completed.
      const need = countMediaTasks(plan.tasks);
      for (const kind of ["image", "video"] as const) {
        if (need[kind] > 0 && !mediaModels[kind]) {
          return fail(
            `The workflow has ${kind} steps, but the project has no usable ${kind} model` +
              (mediaProblems[kind] ? `: ${mediaProblems[kind]}` : "."),
          );
        }
      }
      if (need.image + need.video > mediaLimit) {
        return fail(
          `The workflow generates ${need.image + need.video} images and videos, more than this project's media limit of ${mediaLimit}.`,
        );
      }
    } else {
      const kinds = (["image", "video"] as const).filter((k) => mediaModels[k]);
      const creative =
        kinds.length > 0 && mediaLimit > 0
          ? "\n\nCreative tasks: a task can deliver a generated " +
            kinds.join(" or ") +
            ' instead of text. Give such a task "kind":' +
            kinds.map((k) => `"${k}"`).join(" or ") +
            ' and, if useful, "media":{"aspectRatio":"9:16"' +
            (mediaModels.video ? ',"durationSeconds":8' : "") +
            "}" +
            (mediaModels.video ? " (durationSeconds applies to video)" : "") +
            ". The assigned agent writes the prompt for the generator from the task objective, and each " +
            "such task generates exactly one " +
            kinds.join(" or one ") +
            ". Nobody on the team can see the generated media, only its prompt, so put everything a later " +
            "task needs to know into text tasks. " +
            `Use at most ${mediaLimit} such tasks, and only where the goal asks for visuals.`
          : "";
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
            "its artifact is saved to the project workspace. Keep it minimal and ordered." +
            creative +
            `\n\nAvailable agents:\n${describeAgents(workforce)}`,
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
      // The manager may still ask for media the project has no model for, or
      // for more than its limit: those tasks are delivered as text instead.
      plan = {
        ...plan,
        tasks: downgradeUnavailableMedia(
          plan.tasks,
          { image: Boolean(mediaModels.image), video: Boolean(mediaModels.video) },
          mediaLimit,
        ).tasks,
      };
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
          kind: t.kind,
          mediaOptions: t.kind !== "text" && t.media ? JSON.stringify(t.media) : null,
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
        kind: t.kind,
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

    // Finished outputs by task, for the tasks that depend on them.
    const artifactBySeq = new Map<number, string>();
    // Images + videos started in this run, against the project's media limit.
    let mediaStarted = 0;

    const runTask = async (seq: number): Promise<{ succeeded: boolean; tokens: number }> => {
      const task = bySeq.get(seq)!;
      const planned = planBySeq.get(seq)!;
      const agent = task.agentId ? agentById.get(task.agentId) : undefined;
      const agentName = agent?.name ?? null;
      const kind: TaskKind = planned.kind;
      const mediaModel = kind === "text" ? null : mediaModels[kind];
      const options: MediaOptions = (kind !== "text" && planned.media) || {};

      db.update(projectTasks).set({ status: "running", updatedAt: new Date() }).where(eq(projectTasks.id, task.id)).run();
      emit({ type: "task", seq, title: task.title, status: "running", agent: agentName });

      const failTask = (error: string, attempts: number, tokens: number, assets?: MediaAssetDTO[]) => {
        db.update(projectTasks).set({ status: "failed", error, attempts, updatedAt: new Date() }).where(eq(projectTasks.id, task.id)).run();
        emit({ type: "task", seq, title: task.title, status: "failed", agent: agentName, error, assets });
        return { succeeded: false, tokens };
      };

      if (kind !== "text") {
        // Checked before the agent writes anything, so no tokens are spent on
        // a prompt that cannot be used.
        if (!mediaModel) {
          return failTask(mediaProblems[kind] ?? `The project has no ${kind} model`, 0, 0);
        }
        if (mediaStarted >= mediaLimit) {
          return failTask(`Media limit reached: this project allows ${mediaLimit} images and videos per run`, 0, 0);
        }
        mediaStarted++;
      }

      const depContext = dependencyContext(planned.dependsOn, (d) => {
        const dt = bySeq.get(d);
        return dt ? { title: dt.title, artifact: artifactBySeq.get(d) } : undefined;
      });

      const shape = [
        options.aspectRatio ? `aspect ratio ${options.aspectRatio}` : "",
        kind === "video" && options.durationSeconds ? `about ${options.durationSeconds} seconds long` : "",
      ].filter(Boolean);
      const instruction =
        kind === "text"
          ? `Complete your assigned task and return only the deliverable for it.`
          : `Your deliverable for this task is the prompt for an AI ${kind} generator, which will produce ` +
            `one ${kind}${shape.length ? ` (${shape.join(", ")})` : ""} from it. Return ONLY the prompt: one ` +
            `self-contained paragraph that says exactly what is seen` +
            (kind === "video" ? ", how it moves and how the camera moves" : "") +
            `, in what style and light. The generator knows nothing about this project, so do not refer ` +
            `to other tasks or scenes. No preamble, no quotes, no markdown, no alternatives.`;

      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            `You are ${agent?.name ?? "an agent"}, acting as ${agent?.role ?? "a specialist"}.\n` +
            `${agent?.instructions ?? ""}\n\n` +
            `Overall project goal: ${project.goal}\n` +
            instruction +
            (task.acceptanceCriteria ? `\nAcceptance criteria: ${task.acceptanceCriteria}` : ""),
        },
        {
          role: "user",
          content:
            `Task: ${task.title}\n\n${task.objective}` +
            (depContext ? `\n\nRelevant prior work:\n${depContext}` : ""),
        },
      ];

      // ── The agent's answer: the deliverable, or the prompt for the generator.
      const candidates = buildCandidates(agent, project, routable);
      let answer: { content: string; prompt: number; completion: number } | null = null;
      let lastError = "No model available";
      let attempt = 0;
      let taskTokens = 0;

      for (const mid of candidates) {
        attempt++;
        let resolved: ResolvedModel;
        try {
          resolved = resolveChatModel(mid);
        } catch (e) {
          lastError = e instanceof AppError ? e.message : "Model unavailable";
          db.insert(agentRuns).values({ projectId, taskId: task.id, agentId: agent?.id ?? null, modelRowId: mid, status: "error", attempt, error: lastError }).run();
          continue;
        }
        const started = Date.now();
        try {
          const r = await invoke(resolved, messages, agent?.temperature ?? 0.7);
          const latencyMs = Date.now() - started;
          taskTokens += r.prompt + r.completion;
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
          const content = kind === "text" ? r.content : cleanMediaPrompt(r.content);
          if (kind !== "text" && !content) {
            throw new AppError(502, "empty_prompt", "The agent returned an empty prompt");
          }
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
          answer = { content, prompt: r.prompt, completion: r.completion };
          break;
        } catch (e) {
          lastError = e instanceof AppError ? e.message : sanitizeUpstreamError(e);
          db.insert(agentRuns).values({ projectId, taskId: task.id, agentId: agent?.id ?? null, modelRowId: resolved.model.id, status: "error", attempt, latencyMs: Date.now() - started, error: lastError }).run();
        }
      }

      if (!answer) return failTask(lastError, attempt, taskTokens);

      const succeed = (artifact: string, assets?: MediaAssetDTO[]) => {
        db.update(projectTasks).set({
          status: "succeeded",
          artifact,
          attempts: attempt,
          promptTokens: answer.prompt,
          completionTokens: answer.completion,
          updatedAt: new Date(),
        }).where(eq(projectTasks.id, task.id)).run();
        artifactBySeq.set(seq, artifact);
        emit({ type: "task", seq, title: task.title, status: "succeeded", agent: agentName, artifact, tokens: taskTokens, assets });
        return { succeeded: true, tokens: taskTokens };
      };

      if (kind === "text" || !mediaModel) {
        if (planned.outputFile) {
          try {
            upsertFile(workspace.id, planned.outputFile, answer.content);
          } catch {
            /* invalid path from the model — skip the file write, keep the artifact */
          }
        }
        return succeed(answer.content);
      }

      // ── Generate the image / video from the agent's prompt.
      // The prompt is kept on the task even if generation fails.
      const prompt = answer.content;
      db.update(projectTasks).set({ promptTokens: answer.prompt, completionTokens: answer.completion, updatedAt: new Date() }).where(eq(projectTasks.id, task.id)).run();
      const label = mediaModel.model.displayName || mediaModel.model.modelId;
      const generationStarted = Date.now();
      const logGeneration = (status: "ok" | "error", error?: string) => {
        db.insert(agentRuns).values({
          projectId,
          taskId: task.id,
          agentId: agent?.id ?? null,
          modelRowId: mediaModel.model.id,
          status,
          attempt: attempt + 1,
          latencyMs: Date.now() - generationStarted,
          error,
        }).run();
      };
      const request = {
        userId: project.createdBy,
        modelRowId: mediaModel.model.id,
        prompt,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        size: options.size,
        projectId,
        taskId: task.id,
      };
      const giveUp = (error: string, assets?: MediaAssetDTO[]) => {
        logGeneration("error", error);
        return failTask(`${error}\n\nPrompt: ${prompt}`, attempt + 1, taskTokens, assets);
      };

      try {
        emit({ type: "progress", seq, message: `Generating the ${kind} with ${label}` });
        if (kind === "image") {
          const [asset] = await generateImages({ ...request, n: 1 });
          if (!asset) return giveUp("The provider answered without an image");
          logGeneration("ok");
          attempt++;
          return succeed(
            mediaArtifact({ kind, assetId: asset.id, modelLabel: label, prompt, options }),
            [serializeAsset(asset)],
          );
        }

        const pending = await startVideo({ ...request, durationSeconds: options.durationSeconds });
        const waited = await waitForVideo(pending.id, {
          timeoutMs: VIDEO_WAIT_MS,
          isCancelled: () => cancelled.has(projectId),
          onTick: (elapsed) =>
            emit({ type: "progress", seq, message: `Generating the video with ${label} (${elapsedLabel(elapsed)})` }),
        });
        const dto = serializeAsset(waited.asset);
        if (waited.asset.status === "ready") {
          logGeneration("ok");
          attempt++;
          return succeed(
            mediaArtifact({ kind, assetId: waited.asset.id, modelLabel: label, prompt, options }),
            [dto],
          );
        }
        if (waited.asset.status === "failed") {
          return giveUp(waited.asset.error ?? "The provider could not generate the video", [dto]);
        }
        // Still in progress at the provider: it can finish later in Creative Studio.
        const later = "It is still in progress and will be in Creative Studio if the provider finishes it.";
        if (waited.gaveUp === "cancelled") {
          return giveUp(`Cancelled while the video was being generated. ${later}`, [dto]);
        }
        if (waited.gaveUp === "errors") {
          return giveUp(`Could not check on the video: ${waited.checkError ?? "the provider did not answer"}. ${later}`, [dto]);
        }
        return giveUp(`The video was not finished after ${Math.round(VIDEO_WAIT_MS / 60_000)} minutes. ${later}`, [dto]);
      } catch (e) {
        return giveUp(e instanceof AppError ? e.message : sanitizeUpstreamError(e));
      }
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
    const mediaTasks = succeededTasks.filter((t) => t.kind !== "text");

    let deliverable = "";
    if (succeededTasks.length > 0) {
      const synthMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are the AI Manager. Consolidate the team's task outputs into a single, " +
            "well-structured final deliverable for the user. At the end, briefly note whether each " +
            "task's acceptance criteria appear met — state clearly that this is your assessment, not " +
            "automated verification." +
            (mediaTasks.length > 0
              ? " Some tasks generated an image or a video. You cannot see those: list each one by its " +
                "task title, say what it should show according to its prompt, and say plainly that the " +
                "media itself was not checked."
              : ""),
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
          const reviewModel = resolveChatModel(reviewModelId);
          const execSummary = latestExecSummary(workspace.id);
          const reviewMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                "You are a QA/Security reviewer. For each task, assess whether its deliverable meets the " +
                "acceptance criteria, and flag correctness, security, and missing-requirement concerns. Be " +
                "concise and specific. Where sandbox execution output is provided, ground your judgment in it. " +
                (mediaTasks.length > 0
                  ? "A deliverable that starts with 'Generated image' or 'Generated video' is media you cannot " +
                    "see: review its prompt against the criteria, say that the media itself was not reviewed, " +
                    "and do not count that against the task. "
                  : "") +
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
