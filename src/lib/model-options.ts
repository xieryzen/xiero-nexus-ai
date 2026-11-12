import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelCapabilities, models, providers, type Capability } from "@/db/schema";
import { adapterIsImplemented, getAdapter } from "./adapters";
import { resolveMediaApi, type MediaApi } from "./adapters/media-protocol";
import { MEDIA_CAPABILITY, isMediaOnly } from "./capabilities";

/**
 * The models a user can pick from: enabled, on an enabled provider whose
 * adapter is implemented. One query, shared by the pages that offer a model
 * list, so they all agree on what "usable" means.
 */
export interface UsableModel {
  id: string;
  modelId: string;
  /** Display name, or the model id when it has none. */
  name: string;
  providerName: string;
  adapter: string;
  baseUrl: string;
  mediaApiSetting: string;
  capabilities: Capability[];
  pricePerImage: number | null;
  pricePerSecond: number | null;
}

export function usableModels(): UsableModel[] {
  const rows = db
    .select({
      id: models.id,
      modelId: models.modelId,
      displayName: models.displayName,
      pricePerImage: models.pricePerImage,
      pricePerSecond: models.pricePerSecond,
      providerName: providers.name,
      adapter: providers.adapter,
      baseUrl: providers.baseUrl,
      mediaApiSetting: providers.mediaApi,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .orderBy(asc(models.modelId))
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
    modelId: m.modelId,
    name: m.displayName || m.modelId,
    providerName: m.providerName,
    adapter: m.adapter,
    baseUrl: m.baseUrl,
    mediaApiSetting: m.mediaApiSetting,
    capabilities: caps.get(m.id) ?? [],
    pricePerImage: m.pricePerImage,
    pricePerSecond: m.pricePerSecond,
  }));
}

/** Models that can answer a chat request: everything except image / video models. */
export function chatModels(all: UsableModel[] = usableModels()): UsableModel[] {
  return all.filter((m) => !isMediaOnly(m.capabilities));
}

export interface MediaModelOption {
  id: string;
  /** "<name> · <provider>" */
  label: string;
  /** The request style its provider speaks, which decides the options it takes. */
  mediaApi: MediaApi;
  /** Price per image (image models) or per second (video models), if set. */
  price: number | null;
}

/** Models marked for image or video generation, on an adapter that can do it. */
export function mediaModelOptions(
  kind: "image" | "video",
  all: UsableModel[] = usableModels(),
): MediaModelOption[] {
  return all
    .filter((m) => m.capabilities.includes(MEDIA_CAPABILITY[kind]))
    .filter((m) => {
      const adapter = getAdapter(m.adapter);
      return kind === "image" ? Boolean(adapter.generateImages) : Boolean(adapter.startVideo);
    })
    .map((m) => ({
      id: m.id,
      label: `${m.name} · ${m.providerName}`,
      mediaApi: resolveMediaApi(m.mediaApiSetting, m.baseUrl),
      price: kind === "image" ? m.pricePerImage : m.pricePerSecond,
    }));
}
