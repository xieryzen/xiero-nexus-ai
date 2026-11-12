/**
 * The client-safe shape of a media asset. Pure: shared by the API routes, the
 * server-rendered pages and the client components.
 */
import type { MediaAsset } from "@/db/schema";
import { parseMediaOptions, type MediaOptions } from "../creative/prompt";

export interface MediaAssetDTO {
  id: string;
  kind: "image" | "video";
  status: "pending" | "ready" | "failed";
  prompt: string;
  modelRowId: string | null;
  modelLabel: string;
  /** What was asked for: aspect ratio, duration, resolution, size. */
  options: MediaOptions;
  mimeType: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  error: string | null;
  estimatedCost: number | null;
  projectId: string | null;
  taskId: string | null;
  createdAt: number;
  completedAt: number | null;
  /** Where the file is served from, once it is ready. */
  url: string | null;
  /** Set for administrators looking at everyone's media. */
  owner?: string | null;
}

export function mediaFileUrl(assetId: string): string {
  return `/api/media/${assetId}/file`;
}

export function serializeAsset(asset: MediaAsset, owner?: string | null): MediaAssetDTO {
  const dto: MediaAssetDTO = {
    id: asset.id,
    kind: asset.kind,
    status: asset.status,
    prompt: asset.prompt,
    modelRowId: asset.modelRowId,
    modelLabel: asset.modelLabel,
    options: parseMediaOptions(asset.params),
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    durationSeconds: asset.durationSeconds,
    error: asset.error,
    estimatedCost: asset.estimatedCost,
    projectId: asset.projectId,
    taskId: asset.taskId,
    createdAt: asset.createdAt.getTime(),
    completedAt: asset.completedAt ? asset.completedAt.getTime() : null,
    url: asset.status === "ready" && asset.fileName ? mediaFileUrl(asset.id) : null,
  };
  if (owner !== undefined) dto.owner = owner;
  return dto;
}
