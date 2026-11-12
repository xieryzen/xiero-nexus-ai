import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { serializeAsset } from "@/lib/media/dto";
import { MAX_PENDING_VIDEOS_PER_USER, pendingVideoCount, startVideo } from "@/lib/media/service";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { videoGenerateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Start a video. Answers at once with a `pending` asset; POST
 * /api/media/{id}/refresh moves it forward until it is `ready` or `failed`.
 */
export const POST = handle(async (req) => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`media:video:${user.id}`, 10, 60_000);
  if (!limit.ok) {
    throw Errors.rateLimited("Too many video requests. Wait a minute and try again.");
  }
  const body = await parseBody(req, videoGenerateSchema);

  if (pendingVideoCount(user.id) >= MAX_PENDING_VIDEOS_PER_USER) {
    throw Errors.rateLimited(
      `You already have ${MAX_PENDING_VIDEOS_PER_USER} videos in progress. Wait for one to finish, or delete it.`,
    );
  }

  const asset = await startVideo({
    userId: user.id,
    modelRowId: body.modelRowId,
    prompt: body.prompt,
    durationSeconds: body.durationSeconds,
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    size: body.size,
    extra: body.extra,
  });
  return json({ asset: serializeAsset(asset) }, { status: 201 });
});
