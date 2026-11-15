import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { serializeAsset } from "@/lib/media/dto";
import { ffmpegStatus } from "@/lib/media/ffmpeg";
import { checkRenderInput, createRenderAsset, queueRender } from "@/lib/media/render";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { renderCreateSchema } from "@/lib/validation";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Join clips from the library into one video, on this server, with ffmpeg:
 * videos and images in the order given, voice-overs laid over them, their
 * text burned in as subtitles on request. Answers at once with a `pending`
 * asset; the background worker makes the file.
 */
export const POST = handle(async (req) => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`media:render:${user.id}`, 10, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many requests. Wait a minute and try again.");
  const body = await parseBody(req, renderCreateSchema);

  const ffmpeg = await ffmpegStatus();
  if (!ffmpeg.available || !ffmpeg.h264) {
    throw Errors.badRequest(
      ffmpeg.available
        ? "This server's ffmpeg cannot encode H.264 (it has no libx264), so clips cannot be joined here."
        : "Joining clips needs ffmpeg on the server. An administrator can install it, or set FFMPEG_PATH to the program.",
    );
  }
  // Only what the user may see can go into their video.
  checkRenderInput(body, (asset) => asset.userId === user.id || user.role === "admin");

  const asset = createRenderAsset({ ...body, userId: user.id });
  queueRender(asset);
  kickWorker();
  return json({ asset: serializeAsset(asset) }, { status: 201 });
});
