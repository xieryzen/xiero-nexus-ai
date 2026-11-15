import "server-only";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { env } from "../env";
import { AppError } from "../errors";
import {
  SNIFF_BYTES,
  isMediaFileName,
  maxBytesFor,
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

const EXPECTED: Record<MediaKind, string> = {
  image: "a PNG, JPEG, GIF or WebP image",
  video: "an MP4, MOV or WebM video",
  audio: "an MP3, WAV, Ogg, FLAC, AAC or M4A audio file",
};

function unsupported(kind: MediaKind): AppError {
  return new AppError(502, "unsupported_media", `The file is not ${EXPECTED[kind]}`);
}

function identify(head: Uint8Array, kind: MediaKind): MediaType {
  const type = sniffMedia(head);
  if (!type || type.kind !== kind) throw unsupported(kind);
  return type;
}

/** Store a file held in memory: an image, or generated speech. */
export async function saveMediaBytes(
  assetId: string,
  kind: MediaKind,
  bytes: Buffer | Uint8Array,
): Promise<StoredFile> {
  if (bytes.byteLength > maxBytesFor(kind)) {
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
    { maxBytes: maxBytesFor(kind), timeoutMs },
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

/**
 * Where a file this server makes itself (a video joined by ffmpeg) is written
 * before it is stored. `adoptMediaFile` then checks it and gives it its name.
 */
export async function mediaTempPath(assetId: string): Promise<string> {
  const dir = await ensureMediaDir();
  mediaFileName(assetId, "mp4"); // the id becomes part of the name
  const temp = join(dir, `.${assetId}.part`);
  await rm(temp, { force: true }).catch(() => undefined);
  return temp;
}

/** Store the file written at `mediaTempPath`. It is removed when it is not usable. */
export async function adoptMediaFile(assetId: string, kind: MediaKind): Promise<StoredFile> {
  const dir = await ensureMediaDir();
  const temp = join(dir, `.${assetId}.part`);
  try {
    const info = await stat(temp);
    if (info.size > maxBytesFor(kind)) {
      throw new AppError(502, "upstream_too_large", "The file is larger than the limit");
    }
    const head = Buffer.alloc(SNIFF_BYTES);
    const handle = await open(temp, "r");
    try {
      await handle.read(head, 0, SNIFF_BYTES, 0);
    } finally {
      await handle.close();
    }
    const type = identify(head, kind);
    const fileName = mediaFileName(assetId, type.ext);
    // Another program wrote it: give it the rights the other stored files have.
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, join(dir, fileName));
    return { fileName, mimeType: type.mime, sizeBytes: info.size };
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Absolute path of a stored file, for a program that reads it (ffmpeg). */
export function mediaFilePath(fileName: string): string {
  return pathOf(fileName);
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
