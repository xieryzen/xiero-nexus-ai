import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { serializeAsset } from "@/lib/media/dto";
import { generateImages } from "@/lib/media/service";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { imageGenerateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";
// The provider answers only when the images are finished.
export const maxDuration = 300;

/** Generate images. Answers when they are stored, with the new assets. */
export const POST = handle(async (req) => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`media:image:${user.id}`, 20, 60_000);
  if (!limit.ok) {
    throw Errors.rateLimited("Too many image requests. Wait a minute and try again.");
  }
  const body = await parseBody(req, imageGenerateSchema);

  const assets = await generateImages({
    userId: user.id,
    modelRowId: body.modelRowId,
    prompt: body.prompt,
    n: body.n,
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    size: body.size,
    extra: body.extra,
  });
  return json({ assets: assets.map((a) => serializeAsset(a)) }, { status: 201 });
});
