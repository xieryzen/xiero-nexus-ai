import "server-only";
import { standInsEnabled } from "./model-choice-rules";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  models,
  projectTasks,
  teamAgents,
  teamSkills,
  type Agent,
  type Project,
  type ProjectTask,
  type Team,
  type Workflow,
} from "@/db/schema";
import { parseToolNames } from "./agent/catalog";
import { accountNamesByProject } from "./browser/accounts";
import { serverNamesByProject } from "./ssh/servers";
import { parseMediaOptions, type MediaOptions, type TaskKind } from "./creative/prompt";

function modelLabels(ids: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const clean = [...new Set(ids.filter(Boolean))] as string[];
  if (clean.length === 0) return map;
  for (const m of db
    .select({ id: models.id, modelId: models.modelId, displayName: models.displayName })
    .from(models)
    .where(inArray(models.id, clean))
    .all()) {
    map.set(m.id, m.displayName || m.modelId);
  }
  return map;
}

export interface AgentExtras {
  /** Shared knowledge collections the agent searches. */
  collectionIds?: string[];
  /** Notes the agent has kept. */
  memoryCount?: number;
  /** Skills the agent works by. */
  skillIds?: string[];
}

export function serializeAgent(a: Agent, labels?: Map<string, string>, extras: AgentExtras = {}) {
  const l = labels ?? modelLabels([a.primaryModelRowId ?? "", a.fallbackModelRowId ?? ""]);
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    instructions: a.instructions,
    primaryModelRowId: a.primaryModelRowId,
    primaryModelLabel: a.primaryModelRowId ? l.get(a.primaryModelRowId) ?? null : null,
    fallbackModelRowId: a.fallbackModelRowId,
    fallbackModelLabel: a.fallbackModelRowId ? l.get(a.fallbackModelRowId) ?? null : null,
    routingMode: a.routingMode,
    requiredCapability: a.requiredCapability,
    temperature: a.temperature,
    tools: parseToolNames(a.tools),
    maxSteps: a.maxSteps,
    memoryEnabled: a.memoryEnabled,
    collectionIds: extras.collectionIds ?? [],
    skillIds: extras.skillIds ?? [],
    memoryCount: extras.memoryCount ?? 0,
    status: a.status,
    createdAt: a.createdAt,
  };
}

export function serializeAgents(
  list: Agent[],
  extras: {
    collections?: Map<string, string[]>;
    memories?: Map<string, number>;
    skills?: Map<string, string[]>;
  } = {},
) {
  const labels = modelLabels(list.flatMap((a) => [a.primaryModelRowId ?? "", a.fallbackModelRowId ?? ""]));
  return list.map((a) =>
    serializeAgent(a, labels, {
      collectionIds: extras.collections?.get(a.id),
      memoryCount: extras.memories?.get(a.id),
      skillIds: extras.skills?.get(a.id),
    }),
  );
}

export function serializeTeam(t: Team) {
  const agentIds = db
    .select({ agentId: teamAgents.agentId })
    .from(teamAgents)
    .where(eq(teamAgents.teamId, t.id))
    .all()
    .map((r) => r.agentId);
  const skillIds = db
    .select({ skillId: teamSkills.skillId })
    .from(teamSkills)
    .where(eq(teamSkills.teamId, t.id))
    .all()
    .map((r) => r.skillId);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    agentIds,
    skillIds,
    createdAt: t.createdAt,
  };
}

export function serializeTask(t: ProjectTask) {
  return {
    id: t.id,
    seq: t.seq,
    title: t.title,
    objective: t.objective,
    acceptanceCriteria: t.acceptanceCriteria,
    agentId: t.agentId,
    status: t.status,
    kind: t.kind,
    media: t.kind === "text" ? null : parseMediaOptions(t.mediaOptions),
    dependsOn: t.dependsOn ? (JSON.parse(t.dependsOn) as number[]) : [],
    artifact: t.artifact,
    error: t.error,
    attempts: t.attempts,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
    outputFile: t.outputFile,
    // Model calls and tool calls the task took (an agent with tools).
    steps: t.steps,
    toolCalls: t.toolCallCount,
  };
}

export function serializeProject(p: Project, opts: { withTasks?: boolean } = {}) {
  const base = {
    id: p.id,
    title: p.title,
    goal: p.goal,
    status: p.status,
    managerModelRowId: p.managerModelRowId,
    teamId: p.teamId,
    finalDeliverable: p.finalDeliverable,
    reviewNotes: p.reviewNotes,
    error: p.error,
    maxTasks: p.maxTasks,
    maxParallel: p.maxParallel,
    tokensUsed: p.tokensUsed,
    requiresApproval: p.requiresApproval,
    approved: p.approved,
    hardQaGate: p.hardQaGate,
    workflowId: p.workflowId,
    imageModelRowId: p.imageModelRowId,
    videoModelRowId: p.videoModelRowId,
    speechModelRowId: p.speechModelRowId,
    maxMedia: p.maxMedia,
    memory: p.memory,
    // Whether its runs go on with another model that works when the ones it is
    // set to do not answer: as the project is set, or as the installation is.
    standIns: p.standIns ?? standInsEnabled(process.env.MODEL_STAND_INS),
    // The machines its agents may work on over SSH, by name.
    servers: serverNamesByProject([p.id]).get(p.id) ?? [],
    // The site accounts its agents may sign in with, by name.
    siteAccounts: accountNamesByProject([p.id]).get(p.id) ?? [],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
  };
  if (!opts.withTasks) return { ...base, tasks: [] as ReturnType<typeof serializeTask>[] };
  const tasks = db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.projectId, p.id))
    .orderBy(asc(projectTasks.seq))
    .all()
    .map(serializeTask);
  return { ...base, tasks };
}

export interface WorkflowStep {
  title: string;
  objective: string;
  acceptanceCriteria?: string;
  role: string;
  dependsOn?: number[];
  outputFile?: string;
  /** What the step delivers. Missing means text. */
  kind?: TaskKind;
  media?: MediaOptions;
}

export function serializeWorkflow(w: Workflow) {
  let steps: WorkflowStep[] = [];
  try {
    steps = JSON.parse(w.steps) as WorkflowStep[];
  } catch {
    steps = [];
  }
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    steps: Array.isArray(steps) ? steps : [],
    createdAt: w.createdAt,
  };
}

export type AgentDTO = ReturnType<typeof serializeAgent>;
export type WorkflowDTO = ReturnType<typeof serializeWorkflow>;
export type TeamDTO = ReturnType<typeof serializeTeam>;
export type TaskDTO = ReturnType<typeof serializeTask>;
export type ProjectDTO = ReturnType<typeof serializeProject>;
