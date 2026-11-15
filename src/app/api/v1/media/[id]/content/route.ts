import { mediaFileResponse } from "@/lib/media/serve";
import { loadOwnedAsset } from "@/lib/media/service";
import { v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/** The file of an image, a voice-over or a video of the user's library. */
export const GET = v1("media", (req, { params, caller }) =>
  mediaFileResponse(loadOwnedAsset(params.id!, caller.user), req),
);
