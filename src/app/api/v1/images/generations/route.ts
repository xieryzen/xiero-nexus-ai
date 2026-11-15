import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { generateImages } from "@/lib/media/service";
import { mediaFilePath } from "@/lib/media/store";
import { apiImageSchema, parseApiBody } from "@/lib/public-api/media-requests";
import { mediaContentUrl, readJsonBody, resolveApiModel, v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Generate images. The answer links each image (`url`, fetched with the same
 * API key) or carries it (`response_format: "b64_json"`). The images are also
 * in the user's library in Creative Studio.
 */
export const POST = v1("media", async (req, { caller }) => {
  const body = parseApiBody(apiImageSchema, await readJsonBody(req));
  const assets = await generateImages({
    userId: caller.user.id,
    modelRowId: resolveApiModel(caller, body.model, "image"),
    prompt: body.prompt,
    n: body.n,
    size: body.size,
    aspectRatio: body.aspect_ratio,
    resolution: body.resolution,
  });
  const data = await Promise.all(
    assets.map(async (asset) =>
      body.response_format === "b64_json" && asset.fileName
        ? { id: asset.id, b64_json: (await readFile(mediaFilePath(asset.fileName))).toString("base64") }
        : { id: asset.id, url: mediaContentUrl(asset) },
    ),
  );
  return NextResponse.json({ created: Math.floor(Date.now() / 1000), data });
});
