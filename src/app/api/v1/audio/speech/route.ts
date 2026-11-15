import { mediaFileResponse } from "@/lib/media/serve";
import { generateSpeech } from "@/lib/media/service";
import { apiSpeechSchema, parseApiBody } from "@/lib/public-api/media-requests";
import { readJsonBody, resolveApiModel, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Text to speech. The answer is the audio itself, as with OpenAI's API. Its
 * id in the user's library comes in the `x-nexus-asset-id` header.
 */
export const POST = v1("media", async (req, { caller }) => {
  const body = parseApiBody(apiSpeechSchema, await readJsonBody(req));
  const asset = await generateSpeech({
    userId: caller.user.id,
    modelRowId: resolveApiModel(caller, body.model, "audio"),
    text: body.input,
    voice: body.voice,
    format: body.response_format,
    speed: body.speed,
    instructions: body.instructions,
  });
  // Without a Range header the whole file is sent.
  const res = await mediaFileResponse(asset, new Request(req.url));
  res.headers.set("x-nexus-asset-id", asset.id);
  res.headers.set("cache-control", "no-store");
  return res;
});
