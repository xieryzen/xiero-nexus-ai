import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { providerCredentials, providers, type Provider } from "@/db/schema";
import { adapterIsImplemented } from "./adapters";
import { assertSafeProviderUrl } from "./ssrf";

function allowHosts(): string[] {
  return (process.env.ALLOW_PRIVATE_PROVIDER_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Validate a Base URL (scheme + SSRF/private-range) honoring the allowlist. */
export async function assertAllowedBaseUrl(url: string): Promise<URL> {
  return assertSafeProviderUrl(url, { allowHosts: allowHosts() });
}

export interface CredentialMeta {
  configured: boolean;
  last4: string | null;
  status: "active" | "disabled" | null;
  rotatedAt: Date | null;
}

export function credentialMeta(providerId: string): CredentialMeta {
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
  if (!cred) {
    return { configured: false, last4: null, status: null, rotatedAt: null };
  }
  return {
    configured: true,
    last4: cred.last4 || null,
    status: cred.status,
    rotatedAt: cred.rotatedAt,
  };
}

/** Client-safe provider shape. NEVER includes credential ciphertext/plaintext. */
export function serializeProvider(p: Provider) {
  let extraHeaders: Record<string, string> | null = null;
  if (p.extraHeaders) {
    try {
      extraHeaders = JSON.parse(p.extraHeaders) as Record<string, string>;
    } catch {
      extraHeaders = null;
    }
  }
  return {
    id: p.id,
    name: p.name,
    adapter: p.adapter,
    adapterImplemented: adapterIsImplemented(p.adapter),
    baseUrl: p.baseUrl,
    authType: p.authType,
    authHeaderName: p.authHeaderName,
    apiVersion: p.apiVersion,
    timeoutMs: p.timeoutMs,
    extraHeaders,
    status: p.status,
    priority: p.priority,
    notes: p.notes,
    lastTestedAt: p.lastTestedAt,
    lastTestStatus: p.lastTestStatus,
    lastTestError: p.lastTestError,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    credential: credentialMeta(p.id),
  };
}

export type ProviderDTO = ReturnType<typeof serializeProvider>;
