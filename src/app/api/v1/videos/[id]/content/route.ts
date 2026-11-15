import { Errors } from "@/lib/errors";
import { mediaFileResponse } from "@/lib/media/serve";
import { loadOwnedAsset } from "@/lib/media/service";
import { v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/** The file of a finished video. Byte ranges are supported. */
export const GET = v1("media", async (req, { params, caller }) => {
  const asset = loadOwnedAsset(params.id!, caller.user);
  if (asset.kind !== "video") throw Errors.notFound("Video not found");
  return mediaFileResponse(asset, req);
});
