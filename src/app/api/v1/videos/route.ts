import { NextResponse } from "next/server";
import { Errors } from "@/lib/errors";
import {
  MAX_PENDING_VIDEOS_PER_USER,
  loadOwnedAsset,
  pendingVideoCount,
  startVideo,
} from "@/lib/media/service";
import { apiVideoSchema, parseApiBody } from "@/lib/public-api/media-requests";
import { mediaJson, readJsonBody, resolveApiModel, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/**
 * Start a video. The answer comes at once, with the video `in_progress`;
 * GET /api/v1/videos/{id} says when it is `completed`, and
 * GET /api/v1/videos/{id}/content is the file. With `image_asset_id` the
 * video starts from that image of the user's library.
 */
export const POST = v1("media", async (req, { caller }) => {
  const body = parseApiBody(apiVideoSchema, await readJsonBody(req));
  const modelRowId = resolveApiModel(caller, body.model, "video");
  if (pendingVideoCount(caller.user.id) >= MAX_PENDING_VIDEOS_PER_USER) {
    throw Errors.rateLimited(
      `There are already ${MAX_PENDING_VIDEOS_PER_USER} videos in progress for this account. Wait for one to finish.`,
    );
  }
  if (body.image_asset_id) {
    const image = loadOwnedAsset(body.image_asset_id, caller.user);
    if (image.kind !== "image" || image.status !== "ready") {
      throw Errors.badRequest("image_asset_id must name a finished image");
    }
  }
  const asset = await startVideo({
    userId: caller.user.id,
    modelRowId,
    prompt: body.prompt,
    durationSeconds: body.seconds ?? body.duration,
    size: body.size,
    aspectRatio: body.aspect_ratio,
    resolution: body.resolution,
    imageAssetId: body.image_asset_id,
  });
  return NextResponse.json(mediaJson(asset, caller.user.role), { status: 201 });
});
