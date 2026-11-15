import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { mediaFileResponse } from "@/lib/media/serve";
import { loadOwnedAsset } from "@/lib/media/service";

export const dynamic = "force-dynamic";

/**
 * The stored file of an asset, for its owner or an administrator.
 * Supports byte ranges, which video and audio players need for seeking.
 *   ?download=1   offer it as a download instead of showing it
 */
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  const asset = loadOwnedAsset(params.id!, user);
  return mediaFileResponse(asset, req, {
    download: new URL(req.url).searchParams.get("download") === "1",
  });
});
