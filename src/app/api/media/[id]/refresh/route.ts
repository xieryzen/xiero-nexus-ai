import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { assetFor } from "@/lib/for-viewer";
import { serializeAsset } from "@/lib/media/dto";
import { loadOwnedAsset, refreshVideo } from "@/lib/media/service";
import { textFor } from "@/lib/shown";

export const dynamic = "force-dynamic";
// A finished video is downloaded during this request.
export const maxDuration = 300;

/**
 * Ask the provider about a pending video and store the file once it is
 * finished. The background worker does this by itself; a page that is open
 * calls it as well, to show the result as soon as it is there. `checkError`
 * says why the provider could not be asked this time; the asset is then
 * unchanged. A video being joined on this server is returned as it is.
 */
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  const owned = loadOwnedAsset(params.id!, user);
  const { asset, checkError } = await refreshVideo(owned.id);
  return json({ asset: assetFor(user.role, serializeAsset(asset)), checkError: textFor(user.role, checkError) });
});
