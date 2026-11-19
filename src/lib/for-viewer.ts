import "server-only";
import type { MediaAssetDTO } from "./media/dto";
import type { RunEvent } from "./orchestrator/events";
import { NOT_NOW, NOT_PUT_TOGETHER, WORKING, synthesisFailure, withoutMaker, withoutNeeds } from "./public-text";
import { seesSetup } from "./roles";
import { textFor } from "./shown";
import type { UsageSummary } from "./stats";
import type { ApiKeyDTO } from "./apikeys";
import type { AgentDTO, ProjectDTO, TaskDTO, TeamDTO, WorkflowDTO } from "./workforce";

/**
 * What the server hands out, by the role of who asked. Someone who is shown
 * the setup (roles.ts) gets everything. Anyone else gets their work without
 * what it was done with: no model, no provider, no price, and nothing of how
 * an agent or a skill is set up. It is left out here, on the server, so that
 * it is in no page and in no answer of the API.
 */

type Role = string | null | undefined;

/** An agent: who it is and whether it keeps notes. Not what it is told, what it works with, or what it may use. */
export function agentFor(role: Role, agent: AgentDTO): AgentDTO {
  if (seesSetup(role)) return agent;
  return {
    ...agent,
    instructions: "",
    primaryModelRowId: null,
    primaryModelLabel: null,
    fallbackModelRowId: null,
    fallbackModelLabel: null,
    routingMode: "manual",
    requiredCapability: null,
    temperature: 0,
    tools: [],
    maxSteps: 0,
    collectionIds: [],
    skillIds: [],
  };
}

/** A team: its name, what it is for and who is in it. Not its skills. */
export function teamFor(role: Role, team: TeamDTO): TeamDTO {
  if (seesSetup(role)) return team;
  return { ...team, skillIds: [] };
}

/**
 * A workflow: its name, what it is for, and its steps by title, agent and
 * kind. Not what each step tells its agent, which is the installation's own.
 *
 * The name, the description and the titles are what an administrator wrote
 * for the people who choose the workflow, and are shown as written: only the
 * sentence the app itself once added to a description is left out.
 */
export function workflowFor(role: Role, workflow: WorkflowDTO): WorkflowDTO {
  if (seesSetup(role)) return workflow;
  return {
    ...workflow,
    description: workflow.description ? withoutNeeds(workflow.description) : workflow.description,
    steps: workflow.steps.map((step) => ({
      title: step.title,
      objective: "",
      role: step.role,
      ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      ...(step.kind ? { kind: step.kind } : {}),
    })),
  };
}

/**
 * What a task left in writing. An image, a video or a voice-over leaves a
 * line the app writes, which named the model that made it; a user reads the
 * line without the model. What an agent wrote itself is the user's own work,
 * and stays as it is.
 */
export function artifactFor(role: Role, artifact: string | null | undefined): string | null {
  if (artifact === null || artifact === undefined) return null;
  return seesSetup(role) ? artifact : withoutMaker(artifact);
}

/**
 * The result of a run. When putting it together failed, the app wrote why in
 * its place, in the provider's words; a user reads that it failed, and where
 * the work of the tasks is.
 */
export function deliverableFor(role: Role, deliverable: string | null | undefined): string | null {
  if (deliverable === null || deliverable === undefined) return null;
  if (seesSetup(role)) return deliverable;
  const why = synthesisFailure(deliverable);
  return why !== null && textFor(role, why) !== why ? NOT_PUT_TOGETHER : deliverable;
}

/**
 * A task with what went wrong in words a user may read. `ofWorkflow`: the
 * task is a step of a workflow, so what it tells its agent is the workflow's
 * text and is left out as it is in the workflow itself.
 */
export function taskFor(role: Role, task: TaskDTO, ofWorkflow = false): TaskDTO {
  if (seesSetup(role)) return task;
  return {
    ...task,
    ...(ofWorkflow ? { objective: "", acceptanceCriteria: null } : {}),
    artifact: artifactFor(role, task.artifact),
    error: textFor(role, task.error),
  };
}

/** A project without the models it was set to, and with what went wrong in words a user may read. */
export function projectFor(role: Role, project: ProjectDTO): ProjectDTO {
  if (seesSetup(role)) return project;
  return {
    ...project,
    managerModelRowId: null,
    imageModelRowId: null,
    videoModelRowId: null,
    speechModelRowId: null,
    // Servers are part of the setup, and no project of a user works on one.
    servers: [],
    finalDeliverable: deliverableFor(role, project.finalDeliverable),
    error: textFor(role, project.error),
    tasks: project.tasks.map((task) => taskFor(role, task, Boolean(project.workflowId))),
  };
}

/** A generated file without the model that made it and what it cost. */
export function assetFor(role: Role, asset: MediaAssetDTO): MediaAssetDTO {
  if (seesSetup(role)) return asset;
  return {
    ...asset,
    modelRowId: null,
    modelLabel: "",
    estimatedCost: null,
    error: textFor(role, asset.error),
  };
}

/** What a tool call returned. What a skill says is the installation's own, and is not shown to a user. */
export function toolResultFor(role: Role, name: string, result: string | null): string | null {
  if (seesSetup(role) || result === null) return result;
  if (name === "read_skill") return "(What a skill says is not shown here.)";
  return result;
}

/** An API key without the models it was limited to and what its use cost. */
export function apiKeyFor(role: Role, key: ApiKeyDTO): ApiKeyDTO {
  if (seesSetup(role)) return key;
  return { ...key, modelRowIds: null, monthlyCostLimit: null, monthCost: 0 };
}

/** What was used, without what it was used at and what that cost. */
export function usageFor(role: Role, summary: UsageSummary): UsageSummary {
  if (seesSetup(role)) return summary;
  return {
    ...summary,
    totals: { ...summary.totals, cost: 0 },
    month: { ...summary.month, cost: 0 },
    recent: summary.recent.map((r) => ({ ...r, estimatedCost: null, providerName: null, modelId: null })),
  };
}

/** One event of a run, as this role follows it. */
export function eventFor(role: Role, event: RunEvent): RunEvent {
  if (seesSetup(role)) {
    if (event.type === "progress" && event.full) return { type: "progress", seq: event.seq, message: event.full };
    return event;
  }
  switch (event.type) {
    case "task":
      return {
        ...event,
        ...(event.artifact === undefined ? {} : { artifact: artifactFor(role, event.artifact) }),
        error: textFor(role, event.error),
        assets: event.assets?.map((asset) => assetFor(role, asset)),
      };
    case "final":
      return { type: "final", deliverable: deliverableFor(role, event.deliverable) ?? "" };
    case "progress":
      return { type: "progress", seq: event.seq, message: textFor(role, event.message, WORKING) ?? WORKING };
    case "error":
      return { type: "error", message: textFor(role, event.message) ?? NOT_NOW };
    default:
      return event;
  }
}
