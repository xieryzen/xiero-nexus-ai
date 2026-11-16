import "server-only";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelCapabilities, models, providers, type MediaAsset } from "@/db/schema";
import { adapterIsImplemented } from "../adapters";
import {
  assertKeyAllowsModel,
  authenticateApiKey,
  checkKeyLimits,
  keyModelIds,
  requireScope,
  type ApiCaller,
} from "../apikeys";
import type { Capability } from "../capabilities";
import { isMediaOnly } from "../capabilities";
import { env } from "../env";
import { AppError, PlainError } from "../errors";
import { NOT_SET_UP } from "../public-text";
import { appChoices, kindsAvailable } from "../model-choice";
import type { ChoiceKind } from "../model-choice-rules";
import { seesSetup } from "../roles";
import { errorFor, textFor } from "../shown";
import { readBodyCapped } from "../media/http";
import { isFailing } from "../model-health-rules";
import { withApiKey } from "../request-context";
import type { ApiScope } from "../validation";
import { RequestError, findModel, publicModelNames, type ListableModel } from "./openai-format";

/** The public API (/api/v1): authentication, errors and model names. */

const ERROR_TYPE: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "insufficient_quota",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  413: "invalid_request_error",
  429: "rate_limit_error",
};

/** An error in the shape OpenAI clients read: { error: { message, type, code, param } }. */
export function v1Error(err: unknown): NextResponse {
  if (err instanceof RequestError) {
    return NextResponse.json(
      { error: { message: err.message, type: "invalid_request_error", code: "invalid_request", param: err.param ?? null } },
      { status: 400 },
    );
  }
  if (err instanceof AppError) {
    return NextResponse.json(
      {
        error: {
          message: err.message,
          type: ERROR_TYPE[err.status] ?? (err.status >= 500 ? "api_error" : "invalid_request_error"),
          code: err.code,
          param: null,
        },
      },
      { status: err.status },
    );
  }
  // eslint-disable-next-line no-console
  console.error("[xiero-nexus] unhandled API error:", err);
  return NextResponse.json(
    { error: { message: "Something went wrong", type: "api_error", code: "internal_error", param: null } },
    { status: 500 },
  );
}

type V1Handler = (
  req: Request,
  ctx: { params: Record<string, string>; caller: ApiCaller },
) => Promise<Response> | Response;

/**
 * A route of the public API. The request must carry a key with this scope
 * (`null`: any key), within its limits. The handler runs with the key as its
 * context, so that everything it uses is recorded under the key.
 */
export function v1(scope: ApiScope | null, handler: V1Handler) {
  return async (req: Request, ctx: { params: Record<string, string> }): Promise<Response> => {
    // The role of the key's account, once the key is known: it decides what
    // an error says of the setup (shown.ts).
    let role: string | null | undefined;
    try {
      const caller = authenticateApiKey(req);
      role = caller.user.role;
      if (scope) requireScope(caller.key, scope);
      checkKeyLimits(caller.key);
      return await withApiKey(caller.key.id, () => handler(req, { params: ctx.params, caller }));
    } catch (err) {
      return v1Error(err instanceof AppError && role !== undefined ? errorFor(role, err) : err);
    }
  };
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;

async function readBodyText(req: Request): Promise<string> {
  try {
    return (await readBodyCapped(req, { maxBytes: MAX_JSON_BYTES, timeoutMs: 60_000 })).toString("utf8");
  } catch (err) {
    if (err instanceof AppError && err.code === "upstream_too_large") {
      throw new AppError(413, "request_too_large", "The request body is larger than 4 MB");
    }
    throw new RequestError("The request body could not be read");
  }
}

/** The request body as JSON, read with a size limit. */
export async function readJsonBody(req: Request): Promise<unknown> {
  const text = await readBodyText(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("The request body must be valid JSON");
  }
}

/** As `readJsonBody`, for a request that may come without a body: then `undefined`. */
export async function readOptionalJsonBody(req: Request): Promise<unknown> {
  const text = await readBodyText(req);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("The request body must be valid JSON");
  }
}

export interface ApiModel extends ListableModel {
  displayName: string | null;
  capabilities: Capability[];
  contextWindow: number | null;
  /** It failed its last check: it is not listed, and still answers to its name. */
  failing: boolean;
}

/** The enabled models a key may use, on enabled providers whose adapter exists. */
export function apiModels(caller: ApiCaller): ApiModel[] {
  const allowed = keyModelIds(caller.key);
  const caps = new Map<string, Capability[]>();
  for (const c of db.select().from(modelCapabilities).all()) {
    const list = caps.get(c.modelRowId) ?? [];
    list.push(c.capability);
    caps.set(c.modelRowId, list);
  }
  return db
    .select({
      rowId: models.id,
      modelId: models.modelId,
      displayName: models.displayName,
      contextWindow: models.contextWindow,
      lastTestStatus: models.lastTestStatus,
      providerName: providers.name,
      providerStatus: providers.status,
      adapter: providers.adapter,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(models.enabled, true))
    .all()
    .filter((m) => m.providerStatus === "enabled" && adapterIsImplemented(m.adapter))
    .filter((m) => !allowed || allowed.includes(m.rowId))
    .map((m) => ({
      rowId: m.rowId,
      modelId: m.modelId,
      providerName: m.providerName,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      capabilities: caps.get(m.rowId) ?? [],
      failing: isFailing(m),
    }));
}

export type ModelUse = "chat" | "embeddings" | "image" | "video" | "audio";

const NEEDS: Record<Exclude<ModelUse, "chat">, Capability> = {
  embeddings: "embeddings",
  image: "image_generation",
  video: "video_generation",
  audio: "speech_generation",
};

export function modelFitsUse(model: ApiModel, use: ModelUse): boolean {
  if (use === "chat") return !isMediaOnly(model.capabilities);
  return model.capabilities.includes(NEEDS[use]);
}

/** The name that leaves the choice of the model to the app. */
export const AUTO_MODEL = "auto";

/**
 * What a key of an account that chooses no model is told when it names one.
 * The same whatever it named, so that the answer does not say which names
 * there are.
 */
function onlyAuto(): AppError {
  return new PlainError(
    404,
    "model_not_found",
    `This key names no model. Send "${AUTO_MODEL}" as the model: what the request is done with is chosen for it.`,
  );
}

/** What the app would do this kind of work with, among what the key may use. */
function appChoiceFor(caller: ApiCaller, use: ModelUse, restricted: boolean): string {
  const allowed = restricted ? keyModelIds(caller.key) : null;
  const id = appChoices(use as ChoiceKind).find((choice) => !allowed || allowed.includes(choice));
  if (!id) throw new PlainError(503, "not_set_up", NOT_SET_UP);
  return id;
}

/**
 * The row id of the model a request names, for this use. Throws 404 / 400 / 403.
 *
 * A key of an account that is not shown the setup names no model: it sends
 * "auto", and the app chooses (model-choice.ts). What such a key was limited
 * to when it was made does not count any more: its account chooses no model.
 * A key of an administrator names a model as before, and may send "auto" too.
 */
export function resolveApiModel(caller: ApiCaller, requested: string, use: ModelUse): string {
  if (!seesSetup(caller.user.role)) {
    if (requested.trim().toLowerCase() !== AUTO_MODEL) throw onlyAuto();
    return appChoiceFor(caller, use, false);
  }
  const all = apiModels(caller);
  // Among the models that can do the job first: the same id may exist twice,
  // once as a chat model and once as something else.
  const fitting = all.filter((m) => modelFitsUse(m, use));
  let found = findModel(fitting, requested);
  if (found === null) found = findModel(all, requested);
  if (found === "ambiguous") {
    throw new AppError(
      400,
      "model_ambiguous",
      `More than one provider has a model "${requested}". Name it as "<provider name>/${requested}", as GET /api/v1/models lists it.`,
    );
  }
  // No model goes by "auto" here: the app's choice, among what the key may use.
  if (found === null && requested.trim().toLowerCase() === AUTO_MODEL) return appChoiceFor(caller, use, true);
  if (found === null) {
    throw new AppError(
      404,
      "model_not_found",
      `The model "${requested.slice(0, 120)}" does not exist, is not enabled, or is not open to this API key. GET /api/v1/models lists the models.`,
    );
  }
  assertKeyAllowsModel(caller.key, found);
  return found;
}

/** The name a model goes by in the API. */
export function publicNameOf(caller: ApiCaller, rowId: string): string {
  return publicModelNames(apiModels(caller)).get(rowId) ?? rowId;
}

/** This server's address, for links in answers. */
export function publicOrigin(): string {
  return env.appUrl.replace(/\/+$/, "");
}

export function mediaContentUrl(asset: Pick<MediaAsset, "id" | "kind">): string {
  return asset.kind === "video"
    ? `${publicOrigin()}/api/v1/videos/${asset.id}/content`
    : `${publicOrigin()}/api/v1/media/${asset.id}/content`;
}

function seconds(date: Date | null | undefined): number | null {
  return date ? Math.floor(date.getTime() / 1000) : null;
}

/** The kinds of work a key that names no model can ask for, as the capabilities of "auto". */
export function autoCapabilities(): Capability[] {
  const can = kindsAvailable();
  const out: Capability[] = [];
  if (can.chat) out.push("text");
  if (can.image) out.push("image_generation");
  if (can.video) out.push("video_generation");
  if (can.audio) out.push("speech_generation");
  if (can.embeddings) out.push("embeddings");
  return out;
}

/** A media asset as the API shows it to a key of an account with this role. */
export function mediaJson(asset: MediaAsset, role: string | null | undefined) {
  const sees = seesSetup(role);
  return {
    id: asset.id,
    object: asset.kind,
    // The words OpenAI's video API uses for the same states.
    status: asset.status === "pending" ? "in_progress" : asset.status === "ready" ? "completed" : "failed",
    model: sees ? asset.modelLabel : AUTO_MODEL,
    prompt: asset.prompt,
    created_at: seconds(asset.createdAt),
    completed_at: seconds(asset.completedAt),
    seconds: asset.durationSeconds,
    size_bytes: asset.sizeBytes,
    mime_type: asset.mimeType,
    error: asset.status === "failed" ? { message: textFor(role, asset.error) ?? "Failed" } : null,
    content_url: asset.status === "ready" ? mediaContentUrl(asset) : null,
  };
}

export { seconds as unixSeconds };
