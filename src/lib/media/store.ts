import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { env } from "../env";
import { AppError } from "../errors";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  SNIFF_BYTES,
  isMediaFileName,
  mediaFileName,
  sniffMedia,
  type ByteRange,
  type MediaKind,
  type MediaType,
} from "./files";
import { writeBodyToFile } from "./http";

/**
 * Generated media on disk. One flat folder, one file per asset, named
 * "<asset id>.<ext>". The extension comes from the file's own leading bytes
 * (see files.ts), never from the provider or from user input, and every path
 * is built from a name that matches that pattern, so nothing outside the
 * folder can be read or written through this module.
 */

export interface StoredFile {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** Absolute path of the media folder. */
export function mediaDir(): string {
  return resolve(env.mediaPath);
}

async function ensureMediaDir(): Promise<string> {
  const dir = mediaDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function pathOf(fileName: string): string {
  if (!isMediaFileName(fileName)) {
    throw new AppError(500, "invalid_media_file", "Invalid media file name");
  }
  return join(mediaDir(), fileName);
}

function unsupported(kind: MediaKind): AppError {
  return new AppError(
    502,
    "unsupported_media",
    kind === "image"
      ? "The provider returned a file that is not a PNG, JPEG, GIF or WebP image"
      : "The provider returned a file that is not an MP4, MOV or WebM video",
  );
}

function identify(head: Uint8Array, kind: MediaKind): MediaType {
  const type = sniffMedia(head);
  if (!type || type.kind !== kind) throw unsupported(kind);
  return type;
}

/** Store an image held in memory. */
export async function saveMediaBytes(
  assetId: string,
  kind: MediaKind,
  bytes: Buffer,
): Promise<StoredFile> {
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (bytes.byteLength > limit) {
    throw new AppError(502, "upstream_too_large", "The generated file is larger than the limit");
  }
  const type = identify(bytes.subarray(0, SNIFF_BYTES), kind);
  const dir = await ensureMediaDir();
  const fileName = mediaFileName(assetId, type.ext);
  const temp = join(dir, `.${assetId}.part`);
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await rename(temp, join(dir, fileName));
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { fileName, mimeType: type.mime, sizeBytes: bytes.byteLength };
}

/** Store a download as it arrives, without holding it in memory. */
export async function saveMediaResponse(
  assetId: string,
  kind: MediaKind,
  res: Response,
  timeoutMs: number,
): Promise<StoredFile> {
  const dir = await ensureMediaDir();
  // Checked here because the id becomes part of the temporary file's name.
  mediaFileName(assetId, "mp4");
  const temp = join(dir, `.${assetId}.part`);
  await rm(temp, { force: true }).catch(() => undefined); // left by an interrupted download
  const written = await writeBodyToFile(
    res,
    temp,
    { maxBytes: kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES, timeoutMs },
    SNIFF_BYTES,
  );
  try {
    const type = identify(written.head, kind);
    const fileName = mediaFileName(assetId, type.ext);
    await rename(temp, join(dir, fileName));
    return { fileName, mimeType: type.mime, sizeBytes: written.bytes };
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Size of a stored file, or null when it is not on disk. */
export async function mediaFileSize(fileName: string): Promise<number | null> {
  try {
    const info = await stat(pathOf(fileName));
    return info.isFile() ? info.size : null;
  } catch (err) {
    if (err instanceof AppError) throw err;
    return null;
  }
}

/** A stored file, or one byte range of it, as a web stream. */
export function openMediaFile(fileName: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const stream = createReadStream(
    pathOf(fileName),
    range ? { start: range.start, end: range.end } : undefined,
  );
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

export async function deleteMediaFile(fileName: string | null | undefined): Promise<void> {
  if (!fileName || !isMediaFileName(fileName)) return;
  await rm(join(mediaDir(), fileName), { force: true }).catch(() => undefined);
}
