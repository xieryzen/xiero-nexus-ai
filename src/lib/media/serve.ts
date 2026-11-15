import "server-only";
import type { MediaAsset } from "@/db/schema";
import { Errors } from "../errors";
import { downloadName, mimeForFileName, parseRange } from "./files";
import { mediaFileSize, openMediaFile } from "./store";

/**
 * The stored file of an asset as an HTTP response. The caller has checked
 * that the requester may see the asset.
 *
 * Supports byte ranges, which players need for seeking. The Content-Type
 * comes from the stored file's extension, which was set from the file's own
 * bytes and is limited to a few image, video and audio types, so a response
 * from here is never HTML or SVG.
 */
export async function mediaFileResponse(
  asset: MediaAsset,
  req: Request,
  opts: { download?: boolean } = {},
): Promise<Response> {
  const contentType = asset.fileName ? mimeForFileName(asset.fileName) : null;
  if (asset.status !== "ready" || !asset.fileName || !contentType) {
    throw Errors.notFound("This file is not available");
  }
  const size = await mediaFileSize(asset.fileName);
  if (size === null) throw Errors.notFound("The file is missing from the media folder");

  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-disposition": `${opts.download ? "attachment" : "inline"}; filename="${downloadName(asset.kind, asset.id, asset.fileName)}"`,
    "accept-ranges": "bytes",
    // Private to the signed-in user. The file of an asset never changes.
    "cache-control": "private, max-age=86400, immutable",
    "x-content-type-options": "nosniff",
  };

  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }
  if (range) {
    return new Response(openMediaFile(asset.fileName, range), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }
  return new Response(size === 0 ? null : openMediaFile(asset.fileName), {
    status: 200,
    headers: { ...headers, "content-length": String(size) },
  });
}
