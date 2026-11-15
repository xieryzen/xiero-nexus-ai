import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { ffmpegStatus } from "@/lib/media/ffmpeg";

export const dynamic = "force-dynamic";

/** What this server can do with media by itself: whether it can join clips. */
export const GET = handle(async () => {
  requireUser();
  const ffmpeg = await ffmpegStatus();
  return json({
    render: {
      available: ffmpeg.available && ffmpeg.h264,
      subtitles: ffmpeg.available && ffmpeg.subtitles,
      ffmpegVersion: ffmpeg.version,
    },
  });
});
