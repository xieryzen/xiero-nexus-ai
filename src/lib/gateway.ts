import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  modelCapabilities,
  models,
  providerCredentials,
  providers,
  type Model,
  type Provider,
} from "@/db/schema";
import { getAdapter } from "./adapters";
import { isMediaOnly, type Capability } from "./capabilities";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  EmbedResult,
  ListedModel,
  ProviderContext,
  ToolChoice,
  ToolDefinition,
} from "./adapters/types";
import { noteAnswer, noteFailure } from "./model-standing";
import { failedForNoConnection, sawAnswer, sawFailure } from "./reach";
import { AppError, Errors } from "./errors";
import { decryptSecret } from "./secrets";

function allowedPrivateHosts(): string[] {
  return (process.env.ALLOW_PRIVATE_PROVIDER_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The active, non-disabled credential for a provider (decrypted), or null. */
export function activeCredentialPlaintext(providerId: string): string | null {
  const cred = db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.providerId, providerId),
        eq(providerCredentials.status, "active"),
      ),
    )
    .get();
  if (!cred) return null;
  return decryptSecret(cred.ciphertext);
}

export function buildContext(
  provider: Provider,
  apiKey: string | null,
): ProviderContext {
  let extraHeaders: Record<string, string> | undefined;
  if (provider.extraHeaders) {
    try {
      extraHeaders = JSON.parse(provider.extraHeaders) as Record<string, string>;
    } catch {
      extraHeaders = undefined;
    }
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey: apiKey ?? undefined,
    authType: provider.authType,
    authHeaderName: provider.authHeaderName,
    apiVersion: provider.apiVersion,
    mediaApi: provider.mediaApi,
    config: provider.config,
    extraHeaders,
    timeoutMs: provider.timeoutMs,
    allowHosts: allowedPrivateHosts(),
  };
}

export interface ResolvedModel {
  model: Model;
  provider: Provider;
}

/** Resolve an enabled model on an enabled provider, or throw a safe error. */
export function resolveEnabledModel(modelRowId: string): ResolvedModel {
  const model = db.select().from(models).where(eq(models.id, modelRowId)).get();
  if (!model) throw Errors.notFound("Model not found");
  if (!model.enabled) throw Errors.badRequest("Model is disabled");
  const provider = db
    .select()
    .from(providers)
    .where(eq(providers.id, model.providerId))
    .get();
  if (!provider) throw Errors.notFound("Provider not found");
  if (provider.status !== "enabled") {
    throw Errors.badRequest("Provider is disabled");
  }
  return { model, provider };
}

/**
 * True when the model cannot answer a chat request: it is marked for image,
 * video or speech generation or for embeddings, and not for text.
 */
export function modelIsMediaOnly(modelRowId: string): boolean {
  return isMediaOnly(modelCapabilitiesOf(modelRowId));
}

/**
 * Resolve a model for a chat request: as resolveEnabledModel, and an image /
 * video model is refused here rather than by a confusing upstream error.
 */
export function resolveChatModel(modelRowId: string): ResolvedModel {
  const resolved = resolveEnabledModel(modelRowId);
  if (modelIsMediaOnly(modelRowId)) {
    throw Errors.badRequest(
      `${resolved.model.displayName || resolved.model.modelId} is not a chat model (it is marked for images, video, speech or embeddings) and cannot answer a chat request`,
    );
  }
  return resolved;
}

/** Test a provider connection using a supplied or stored credential. */
export async function testProviderConnection(
  provider: Provider,
  apiKeyPlaintext: string | null,
): Promise<void> {
  const adapter = getAdapter(provider.adapter);
  const key =
    apiKeyPlaintext ??
    (provider.authType === "none" ? null : activeCredentialPlaintext(provider.id));
  if (provider.authType !== "none" && !key) {
    throw Errors.badRequest("No API key configured for this provider");
  }
  await adapter.testConnection(buildContext(provider, key));
}

/** List upstream models for discovery, with what the provider says about each. */
export async function discoverProviderModels(
  provider: Provider,
): Promise<ListedModel[]> {
  const adapter = getAdapter(provider.adapter);
  if (!adapter.canDiscoverModels) {
    throw Errors.badRequest("This adapter does not support model discovery");
  }
  const key =
    provider.authType === "none" ? null : activeCredentialPlaintext(provider.id);
  if (provider.authType !== "none" && !key) {
    throw Errors.badRequest("No API key configured for this provider");
  }
  return adapter.listModels(buildContext(provider, key));
}

/** The context for calling a provider with its stored credential. */
export function contextFor(provider: Provider): ProviderContext {
  const key =
    provider.authType === "none" ? null : activeCredentialPlaintext(provider.id);
  if (provider.authType !== "none" && !key) {
    throw Errors.badRequest("No API key configured for this provider");
  }
  return buildContext(provider, key);
}

export interface ChatOptions {
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  /**
   * Whether the request ended well is not written down for the model
   * (model-standing.ts): for the check of the models, which writes its own
   * result.
   */
  unnoted?: boolean;
}

function chatRequest(resolved: ResolvedModel, messages: ChatMessage[], opts: ChatOptions): ChatRequest {
  return {
    model: resolved.model.modelId,
    messages,
    temperature: opts.temperature,
    tools: opts.tools?.length ? opts.tools : undefined,
    toolChoice: opts.tools?.length ? opts.toolChoice : undefined,
    maxTokens: opts.maxTokens,
  };
}

/**
 * A request failed: written down for the model (model-standing.ts), unless
 * it failed because this server is cut off (reach.ts). That says nothing
 * about the model, and three such requests would put it away.
 */
async function noteFailed(resolved: ResolvedModel, err: unknown, opts: ChatOptions): Promise<void> {
  sawFailure(err);
  if (opts.unnoted) return;
  let cutOff = false;
  try {
    cutOff = await failedForNoConnection(resolved.provider, err);
  } catch {
    cutOff = false;
  }
  if (!cutOff) noteFailure(resolved.model, resolved.provider, err);
}

/** Non-streaming chat completion through the resolved provider/model. */
export async function gatewayChat(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const adapter = getAdapter(resolved.provider.adapter);
  try {
    const result = await adapter.chat(contextFor(resolved.provider), chatRequest(resolved, messages, opts));
    sawAnswer();
    if (!opts.unnoted) noteAnswer(resolved.model, resolved.provider);
    return result;
  } catch (err) {
    await noteFailed(resolved, err, opts);
    throw err;
  }
}

/** Streaming chat completion; forwards text deltas to `onDelta`. */
export async function gatewayChatStream(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const adapter = getAdapter(resolved.provider.adapter);
  try {
    const result = await adapter.chatStream(contextFor(resolved.provider), chatRequest(resolved, messages, opts), onDelta);
    sawAnswer();
    if (!opts.unnoted) noteAnswer(resolved.model, resolved.provider);
    return result;
  } catch (err) {
    await noteFailed(resolved, err, opts);
    throw err;
  }
}

/** The capabilities an administrator ticked for a model. */
export function modelCapabilitiesOf(modelRowId: string): Capability[] {
  return db
    .select({ capability: modelCapabilities.capability })
    .from(modelCapabilities)
    .where(eq(modelCapabilities.modelRowId, modelRowId))
    .all()
    .map((c) => c.capability);
}

/**
 * An enabled model marked for embeddings, on an adapter that has them, or a
 * safe error.
 */
export function resolveEmbeddingModel(modelRowId: string): ResolvedModel {
  const resolved = resolveEnabledModel(modelRowId);
  if (!modelCapabilitiesOf(modelRowId).includes("embeddings")) {
    throw Errors.badRequest(
      "This model is not marked for embeddings. An administrator can add that capability on the Models page.",
    );
  }
  const adapter = getAdapter(resolved.provider.adapter);
  if (!adapter.embed) {
    throw Errors.badRequest(`The ${adapter.label} adapter has no embeddings API.`);
  }
  return resolved;
}

/** Embed texts with a model. Resolves to one vector per text, in order. */
export async function gatewayEmbed(
  resolved: ResolvedModel,
  input: string[],
  opts: { dimensions?: number } = {},
): Promise<EmbedResult> {
  const adapter = getAdapter(resolved.provider.adapter);
  if (!adapter.embed) {
    throw Errors.badRequest(`The ${adapter.label} adapter has no embeddings API.`);
  }
  if (input.length === 0) return { vectors: [] };
  const result = await adapter.embed(contextFor(resolved.provider), {
    model: resolved.model.modelId,
    input,
    dimensions: opts.dimensions,
  });
  if (result.vectors.length !== input.length) {
    throw new AppError(502, "upstream_error", "Provider returned fewer embeddings than texts");
  }
  return result;
}

export { AppError };
