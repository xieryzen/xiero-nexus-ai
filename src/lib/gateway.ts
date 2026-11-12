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
import { isMediaOnly } from "./capabilities";
import type { ChatMessage, ChatRequest, ChatResult, ProviderContext } from "./adapters/types";
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

/** True when the model is marked for image / video generation and not for text. */
export function modelIsMediaOnly(modelRowId: string): boolean {
  const capabilities = db
    .select({ capability: modelCapabilities.capability })
    .from(modelCapabilities)
    .where(eq(modelCapabilities.modelRowId, modelRowId))
    .all()
    .map((c) => c.capability);
  return isMediaOnly(capabilities);
}

/**
 * Resolve a model for a chat request: as resolveEnabledModel, and an image /
 * video model is refused here rather than by a confusing upstream error.
 */
export function resolveChatModel(modelRowId: string): ResolvedModel {
  const resolved = resolveEnabledModel(modelRowId);
  if (modelIsMediaOnly(modelRowId)) {
    throw Errors.badRequest(
      `${resolved.model.displayName || resolved.model.modelId} only generates images or videos and cannot answer a chat request`,
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

/** List upstream models for discovery. */
export async function discoverProviderModels(
  provider: Provider,
): Promise<string[]> {
  const adapter = getAdapter(provider.adapter);
  if (!adapter.canDiscoverModels) {
    throw Errors.badRequest("This adapter does not support model discovery");
  }
  const key =
    provider.authType === "none" ? null : activeCredentialPlaintext(provider.id);
  if (provider.authType !== "none" && !key) {
    throw Errors.badRequest("No API key configured for this provider");
  }
  const listed = await adapter.listModels(buildContext(provider, key));
  return listed.map((m) => m.id);
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

/** Non-streaming chat completion through the resolved provider/model. */
export async function gatewayChat(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  opts: { temperature?: number } = {},
): Promise<ChatResult> {
  const adapter = getAdapter(resolved.provider.adapter);
  const req: ChatRequest = {
    model: resolved.model.modelId,
    messages,
    temperature: opts.temperature,
  };
  return adapter.chat(contextFor(resolved.provider), req);
}

/** Streaming chat completion; forwards text deltas to `onDelta`. */
export async function gatewayChatStream(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  opts: { temperature?: number } = {},
): Promise<ChatResult> {
  const adapter = getAdapter(resolved.provider.adapter);
  const req: ChatRequest = {
    model: resolved.model.modelId,
    messages,
    temperature: opts.temperature,
  };
  return adapter.chatStream(contextFor(resolved.provider), req, onDelta);
}

export { AppError };
