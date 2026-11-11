import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  modelCapabilities,
  providers,
  type Capability,
  type Model,
} from "@/db/schema";

export interface SerializedModel {
  id: string;
  providerId: string;
  providerName: string | null;
  modelId: string;
  displayName: string | null;
  enabled: boolean;
  contextWindow: number | null;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  source: "discovered" | "manual";
  capabilities: { capability: Capability; verified: boolean }[];
  lastTestedAt: Date | null;
  lastTestStatus: "ok" | "error" | null;
  lastTestError: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function capsByModel(modelRowIds: string[]): Map<
  string,
  { capability: Capability; verified: boolean }[]
> {
  const map = new Map<string, { capability: Capability; verified: boolean }[]>();
  if (modelRowIds.length === 0) return map;
  const rows = db
    .select()
    .from(modelCapabilities)
    .where(inArray(modelCapabilities.modelRowId, modelRowIds))
    .all();
  for (const r of rows) {
    const list = map.get(r.modelRowId) ?? [];
    list.push({ capability: r.capability, verified: r.verified });
    map.set(r.modelRowId, list);
  }
  return map;
}

export function serializeModels(rows: Model[]): SerializedModel[] {
  const providerNames = new Map<string, string>();
  const provIds = [...new Set(rows.map((r) => r.providerId))];
  if (provIds.length) {
    for (const p of db
      .select({ id: providers.id, name: providers.name })
      .from(providers)
      .where(inArray(providers.id, provIds))
      .all()) {
      providerNames.set(p.id, p.name);
    }
  }
  const caps = capsByModel(rows.map((r) => r.id));
  return rows.map((m) => ({
    id: m.id,
    providerId: m.providerId,
    providerName: providerNames.get(m.providerId) ?? null,
    modelId: m.modelId,
    displayName: m.displayName,
    enabled: m.enabled,
    contextWindow: m.contextWindow,
    inputPricePerMTok: m.inputPricePerMTok,
    outputPricePerMTok: m.outputPricePerMTok,
    source: m.source,
    capabilities: caps.get(m.id) ?? [],
    lastTestedAt: m.lastTestedAt,
    lastTestStatus: m.lastTestStatus,
    lastTestError: m.lastTestError,
    notes: m.notes,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }));
}

export function serializeModel(m: Model): SerializedModel {
  return serializeModels([m])[0]!;
}

/** Replace a model's capability set. Manually-set capabilities are unverified. */
export function setCapabilities(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  modelRowId: string,
  capabilities: Capability[],
): void {
  tx.delete(modelCapabilities)
    .where(inArray(modelCapabilities.modelRowId, [modelRowId]))
    .run();
  const unique = [...new Set(capabilities)];
  for (const capability of unique) {
    tx.insert(modelCapabilities)
      .values({ modelRowId, capability, verified: false })
      .run();
  }
}
