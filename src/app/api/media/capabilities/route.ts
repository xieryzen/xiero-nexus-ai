import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { ffmpegStatus } from "@/lib/media/ffmpeg";
import { seesSetup } from "@/lib/roles";

export const dynamic = "force-dynamic";

/** What this server can do with media by itself: whether it can join clips. */
export const GET = handle(async () => {
  const user = requireUser();
  const ffmpeg = await ffmpegStatus();
  return json({
    render: {
      available: ffmpeg.available && ffmpeg.h264,
      subtitles: ffmpeg.available && ffmpeg.subtitles,
      // What is installed on the server is said to those who are shown the setup.
      ffmpegVersion: seesSetup(user.role) ? ffmpeg.version : null,
    },
  });
});
