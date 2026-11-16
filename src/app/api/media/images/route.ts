import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { assetFor } from "@/lib/for-viewer";
import { serializeAsset } from "@/lib/media/dto";
import { generateImages } from "@/lib/media/service";
import { modelFor } from "@/lib/model-choice";
import { seesSetup } from "@/lib/roles";
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
    modelRowId: modelFor(user.role, body.modelRowId, "image"),
    prompt: body.prompt,
    n: body.n,
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    size: body.size,
    // Options of one provider are for those who know which provider it is.
    extra: seesSetup(user.role) ? body.extra : undefined,
  });
  return json({ assets: assets.map((a) => assetFor(user.role, serializeAsset(a))) }, { status: 201 });
});
