import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { serializeAsset } from "@/lib/media/dto";
import { loadOwnedAsset, refreshVideo } from "@/lib/media/service";

export const dynamic = "force-dynamic";
// A finished video is downloaded during this request.
export const maxDuration = 300;

/**
 * Ask the provider about a pending video and store the file once it is
 * finished. The page calls this every few seconds while a video is pending.
 * `checkError` says why the provider could not be asked this time; the asset
 * is then unchanged.
 */
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  const owned = loadOwnedAsset(params.id!, user);
  const { asset, checkError } = await refreshVideo(owned.id);
  return json({ asset: serializeAsset(asset), checkError: checkError ?? null });
});
