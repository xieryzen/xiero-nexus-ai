import { modelFor } from "@/lib/model-choice";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { assetFor } from "@/lib/for-viewer";
import { serializeAsset } from "@/lib/media/dto";
import { generateSpeech } from "@/lib/media/service";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { speechGenerateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";
// The provider answers only when the audio is finished.
export const maxDuration = 300;

/** Generate speech from text. Answers when the audio is stored, with the new asset. */
export const POST = handle(async (req) => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`media:speech:${user.id}`, 20, 60_000);
  if (!limit.ok) {
    throw Errors.rateLimited("Too many speech requests. Wait a minute and try again.");
  }
  const body = await parseBody(req, speechGenerateSchema);
  const asset = await generateSpeech({
    userId: user.id,
    modelRowId: modelFor(user.role, body.modelRowId, "audio"),
    text: body.text,
    voice: body.voice,
    format: body.format,
    speed: body.speed,
    instructions: body.instructions,
  });
  return json({ asset: assetFor(user.role, serializeAsset(asset)) }, { status: 201 });
});
