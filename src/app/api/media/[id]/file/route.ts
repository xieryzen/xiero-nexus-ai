import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { downloadName, mimeForFileName, parseRange } from "@/lib/media/files";
import { loadOwnedAsset } from "@/lib/media/service";
import { mediaFileSize, openMediaFile } from "@/lib/media/store";

export const dynamic = "force-dynamic";

/**
 * The stored file of an asset, for its owner or an administrator.
 * Supports byte ranges, which video players need for seeking.
 *   ?download=1   offer it as a download instead of showing it
 *
 * The Content-Type comes from the stored file's extension, which was set from
 * the file's own bytes and is limited to a few image and video types, so a
 * response from here is never HTML or SVG.
 */
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  const asset = loadOwnedAsset(params.id!, user);
  const contentType = asset.fileName ? mimeForFileName(asset.fileName) : null;
  if (asset.status !== "ready" || !asset.fileName || !contentType) {
    throw Errors.notFound("This file is not available");
  }
  const size = await mediaFileSize(asset.fileName);
  if (size === null) throw Errors.notFound("The file is missing from the media folder");

  const asDownload = new URL(req.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-disposition": `${asDownload ? "attachment" : "inline"}; filename="${downloadName(asset.kind, asset.id, asset.fileName)}"`,
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
});
