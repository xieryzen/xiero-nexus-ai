import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError, Errors } from "@/lib/errors";
import { serializeAsset } from "@/lib/media/dto";
import { MAX_IMAGE_BYTES } from "@/lib/media/files";
import { readBodyCapped } from "@/lib/media/http";
import { storeUploadedImage } from "@/lib/media/service";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Upload an image into the library, to start a video from or to use as a
 * still when clips are joined. The body is the file itself; its name comes in
 * the `x-file-name` header (URL-encoded). What the file is, is read from its
 * own bytes: only PNG, JPEG, GIF and WebP are stored.
 */
export const POST = handle(async (req) => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`media:upload:${user.id}`, 30, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many uploads. Wait a minute and try again.");

  let bytes: Buffer;
  try {
    bytes = await readBodyCapped(req, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 120_000 });
  } catch (err) {
    if (err instanceof AppError && err.code === "upstream_too_large") {
      throw new AppError(
        413,
        "too_large",
        `An image can be at most ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`,
      );
    }
    throw Errors.badRequest("The upload did not arrive completely. Try again.");
  }

  let name = "";
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") ?? "");
  } catch {
    name = "";
  }
  const asset = await storeUploadedImage({ userId: user.id, bytes, name });
  return json({ asset: serializeAsset(asset) }, { status: 201 });
});
