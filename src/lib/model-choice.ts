import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelCapabilities, models, providers, users, workflows, type Capability, type Project } from "@/db/schema";
import { adapterIsImplemented, getAdapter } from "./adapters";
import { PlainError } from "./errors";
import { isFailing, isResting } from "./model-health-rules";
import {
  CHOICE_KINDS,
  askingOrder,
  choicesFor,
  fitsKind,
  priceCeiling,
  priceFor,
  standInsEnabled,
  standInsFor,
  type ChoiceKind,
  type ChoiceModel,
} from "./model-choice-rules";
import { countMediaTasks } from "./orchestrator/plan";
import { NOT_SET_UP } from "./public-text";
import { seesSetup } from "./roles";

/**
 * The model the app works with where a user would have chosen one: for a
 * chat, for the manager of a project, for an image, a video, a voice-over,
 * and for the knowledge base. The rules are in model-choice-rules.ts.
 */

interface Askable extends ChoiceModel {
  providerId: string;
  providerName: string;
  adapter: string;
  /** Not chosen before this time: it did not answer a moment ago. */
  retryAt: Date | null;
  /** The model's prices, for the order within each kind. */
  prices: Parameters<typeof priceFor>[0];
}

/** Whether a provider on this adapter does this kind of work at all. */
function adapterDoes(adapterId: string, kind: ChoiceKind): boolean {
  const adapter = getAdapter(adapterId);
  if (kind === "image") return Boolean(adapter.generateImages);
  if (kind === "video") return Boolean(adapter.startVideo);
  if (kind === "audio") return Boolean(adapter.generateSpeech);
  if (kind === "embeddings") return Boolean(adapter.embed);
  return true;
}

/** Every model that is switched on, on a provider that is switched on and whose adapter exists. */
function askable(): Askable[] {
  const rows = db
    .select({
      id: models.id,
      modelId: models.modelId,
      displayName: models.displayName,
      forUsers: models.forUsers,
      lastTestStatus: models.lastTestStatus,
      retryAt: models.retryAt,
      inputPricePerMTok: models.inputPricePerMTok,
      outputPricePerMTok: models.outputPricePerMTok,
      pricePerImage: models.pricePerImage,
      pricePerSecond: models.pricePerSecond,
      pricePerMChars: models.pricePerMChars,
      providerId: providers.id,
      providerName: providers.name,
      adapter: providers.adapter,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .all()
    .filter((m) => adapterIsImplemented(m.adapter));
  if (rows.length === 0) return [];
  const caps = new Map<string, Capability[]>();
  for (const c of db.select().from(modelCapabilities).all()) {
    const list = caps.get(c.modelRowId) ?? [];
    list.push(c.capability);
    caps.set(c.modelRowId, list);
  }
  return rows.map((m) => ({
    id: m.id,
    name: m.displayName || m.modelId,
    capabilities: caps.get(m.id) ?? [],
    forUsers: m.forUsers,
    failing: isFailing(m),
    price: null,
    providerId: m.providerId,
    providerName: m.providerName,
    adapter: m.adapter,
    retryAt: m.retryAt,
    prices: m,
  }));
}

// ─── Stand-ins ───────────────────────────────────────────────────────────

export interface AskingOrder {
  /** The models to ask, the first first. */
  ids: string[];
  /** The ones among them that the work was not set to: the app's own choice. */
  standIns: Set<string>;
}

/**
 * The models a piece of chat work asks, in order: a task of a run with the
 * models of its agent and of its project, or the manager of a run. The ones
 * it is set to that can be used now come first, then the stand-ins (other
 * models that work, model-choice-rules.ts), then the ones it is set to that
 * are failing or resting, which are asked when nothing else answered.
 *
 * Read anew each time it is called: what is known about the models changes
 * while a run works. `standIns`: whether others may stand in, where the work
 * says so itself; otherwise MODEL_STAND_INS decides (on unless switched off).
 */
export function askingOrderFor(own: readonly string[], opts: { wantsTools?: boolean; standIns?: boolean | null } = {}): AskingOrder {
  const now = Date.now();
  const all = askable();
  const chat = all.map((m) => ({ ...m, price: priceFor(m.prices, "chat") }));
  const byId = new Map(chat.map((m) => [m.id, m] as const));
  const usable = new Set(chat.filter((m) => !m.failing && !isResting(m, now)).map((m) => m.id));
  let standIns: string[] = [];
  // As the work is set (a project says so), or as the installation is.
  if (opts.standIns ?? standInsEnabled(process.env.MODEL_STAND_INS)) {
    // A model that is set and cannot be found has no price to compare with: it sets no limit.
    const set = [...new Set(own)].map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
    standIns = standInsFor(
      chat.map((m) => ({
        ...m,
        resting: isResting(m, now),
        tools: m.capabilities.includes("tool_calling") && getAdapter(m.adapter).supports.includes("tool_calling"),
      })),
      { own, ceiling: priceCeiling(set.map((m) => m.price)), wantsTools: opts.wantsTools === true },
    );
  }
  return { ids: askingOrder(own, usable, standIns), standIns: new Set(standIns) };
}

function choices(all: Askable[], kind: ChoiceKind): string[] {
  return choicesFor(
    all.filter((m) => adapterDoes(m.adapter, kind)).map((m) => ({ ...m, price: priceFor(m.prices, kind) })),
    kind,
  );
}

/** The models the app works with for this kind of work, the first choice first. */
export function appChoices(kind: ChoiceKind): string[] {
  return choices(askable(), kind);
}

/** The app's first choice for this kind of work, or null when nothing can do it. */
export function appChoice(kind: ChoiceKind): string | null {
  return appChoices(kind)[0] ?? null;
}

/** As appChoices, or an error that says the installation cannot do this yet. */
export function requireAppChoices(kind: ChoiceKind): string[] {
  const ids = appChoices(kind);
  if (ids.length === 0) throw new PlainError(503, "not_set_up", NOT_SET_UP);
  return ids;
}

/**
 * The app's choices for a conversation that works with tools (chat/turn.ts):
 * as requireAppChoices("chat"), with the models that can be used now before
 * the ones that fail or rest, and among those the ones marked for tool
 * calling, on an adapter that does it, first. A model without tools can
 * answer, and cannot act.
 */
export function requireChatChoices(): string[] {
  const all = askable();
  const ids = choices(all, "chat");
  if (ids.length === 0) throw new PlainError(503, "not_set_up", NOT_SET_UP);
  const now = Date.now();
  const byId = new Map(all.map((m) => [m.id, m] as const));
  const rank = (id: string): number => {
    const m = byId.get(id);
    if (!m) return 4;
    const tools = m.capabilities.includes("tool_calling") && getAdapter(m.adapter).supports.includes("tool_calling");
    const away = m.failing || isResting(m, now);
    return (away ? 2 : 0) + (tools ? 0 : 1);
  };
  return ids
    .map((id, index) => ({ id, index, rank: rank(id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((m) => m.id);
}

export function requireAppChoice(kind: ChoiceKind): string {
  return requireAppChoices(kind)[0]!;
}

/**
 * The model a request is done with: the one it names, for someone who is
 * shown the setup and names one; the app's choice for anyone else, whatever
 * the request names.
 */
export function modelFor(role: string | null | undefined, named: string | null | undefined, kind: ChoiceKind): string {
  if (seesSetup(role) && named) return named;
  return requireAppChoice(kind);
}

/** Which kinds of work the installation can do for someone who chooses no model. */
export function kindsAvailable(): Record<ChoiceKind, boolean> {
  const all = askable();
  const out = {} as Record<ChoiceKind, boolean>;
  for (const kind of CHOICE_KINDS) out[kind] = choices(all, kind).length > 0;
  return out;
}

export interface UsersModel {
  kind: ChoiceKind;
  /** The app's first choice: "<name> · <provider>". Null when nothing can do this kind of work. */
  first: { id: string; label: string } | null;
  /** How many models of this kind are marked for users. */
  marked: number;
  /** How many models the app would turn to, the first included. */
  choices: number;
}

/** What users work with, kind by kind. For the Models page. */
export function whatUsersGet(): UsersModel[] {
  const all = askable();
  const byId = new Map(all.map((m) => [m.id, m] as const));
  return CHOICE_KINDS.map((kind) => {
    const ids = choices(all, kind);
    const first = ids[0] ? byId.get(ids[0]) : undefined;
    return {
      kind,
      first: first ? { id: first.id, label: `${first.name} · ${first.providerName}` } : null,
      marked: all.filter((m) => m.forUsers && adapterDoes(m.adapter, kind) && fitsKind(m.capabilities, kind)).length,
      choices: ids.length,
    };
  });
}

// ─── Projects ────────────────────────────────────────────────────────────

/**
 * Whether the account a project belongs to chooses the project's models. An
 * administrator does; for a user the app does. A project whose account was
 * deleted is run with what it was set to, as an administrator's.
 */
export function projectOwnerChooses(project: Pick<Project, "createdBy">): boolean {
  if (!project.createdBy) return true;
  const owner = db.select({ role: users.role }).from(users).where(eq(users.id, project.createdBy)).get();
  return !owner || seesSetup(owner.role);
}

/** How many steps of each generated kind a project's workflow has. */
export function workflowMediaNeeds(workflowId: string | null): { image: number; video: number; audio: number } {
  const none = { image: 0, video: 0, audio: 0 };
  if (!workflowId) return none;
  const row = db.select({ steps: workflows.steps }).from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!row) return none;
  try {
    const steps = JSON.parse(row.steps) as { kind?: string }[];
    if (!Array.isArray(steps)) return none;
    const counted = countMediaTasks(steps.map((step) => ({ kind: (step.kind ?? "text") as never })));
    return { image: counted.image, video: counted.video, audio: counted.audio };
  } catch {
    return none;
  }
}

/**
 * A project as its run works with it: the same project, with the models the
 * run uses in the places of the ones it was set to.
 *
 * - An administrator's project works with what it was set to. Only a project
 *   without a manager (it was made by a user who is an administrator now)
 *   gets the app's choice for one.
 * - A user's project works with the app's choice, whatever it was set to: for
 *   its manager always, and for images, videos and voice-overs when it asks
 *   for them. It asks for a kind when its workflow has such steps, or when it
 *   was made with that kind ticked (which is kept as a model in that place).
 */
export function withRunModels(project: Project): Project {
  if (projectOwnerChooses(project)) {
    return project.managerModelRowId ? project : { ...project, managerModelRowId: appChoice("chat") };
  }
  const all = askable();
  const first = (kind: ChoiceKind) => choices(all, kind)[0] ?? null;
  const needs = workflowMediaNeeds(project.workflowId);
  return {
    ...project,
    managerModelRowId: first("chat"),
    imageModelRowId: project.imageModelRowId || needs.image > 0 ? first("image") : null,
    videoModelRowId: project.videoModelRowId || needs.video > 0 ? first("video") : null,
    speechModelRowId: project.speechModelRowId || needs.audio > 0 ? first("audio") : null,
  };
}
