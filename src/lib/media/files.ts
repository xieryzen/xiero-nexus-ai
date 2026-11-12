/**
 * Media file rules: what a generated file is allowed to be, what it is called
 * on disk, and how a byte range is read from it. Pure and dependency-free so
 * the rules can be unit-tested.
 */

export type MediaKind = "image" | "video";

export interface MediaType {
  kind: MediaKind;
  mime: string;
  ext: string;
}

/** Largest file the gateway will store, per kind. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** How many leading bytes `sniffMedia` needs. */
export const SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

/**
 * Identify a file by its leading bytes. The type a provider claims is never
 * trusted, and anything outside this list is refused, because stored files are
 * later served to browsers under the app's own origin: an SVG or HTML file
 * could run script there.
 */
export function sniffMedia(bytes: Uint8Array): MediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  }
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") {
    return { kind: "image", mime: "image/gif", ext: "gif" };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    // The same container also carries still images (HEIC, AVIF).
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return null;
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov" };
    return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: "video", mime: "video/webm", ext: "webm" };
  }
  return null;
}

const FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp|mp4|mov|webm)$/;

/** The on-disk name of an asset's file: its id plus the sniffed extension. */
export function mediaFileName(assetId: string, ext: string): string {
  const name = `${assetId}.${ext}`;
  if (!FILE_NAME.test(name)) throw new Error("Invalid media file name");
  return name;
}

/** True for names this module produced. Guards every path built from the DB. */
export function isMediaFileName(name: string): boolean {
  return FILE_NAME.test(name);
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/**
 * The Content-Type a stored file is served with, from its extension, which was
 * set from the file's own bytes when it was stored. Null for any other name.
 */
export function mimeForFileName(fileName: string): string | null {
  if (!FILE_NAME.test(fileName)) return null;
  return MIME_BY_EXT[fileName.slice(fileName.lastIndexOf(".") + 1)] ?? null;
}

/** A neutral name for the browser's download dialog. */
export function downloadName(kind: MediaKind, assetId: string, fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1);
  return `xiero-${kind}-${assetId.slice(0, 8)}.${ext}`;
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parse a `Range` header for a file of `size` bytes.
 * Returns the range, `"unsatisfiable"` (answer 416), or `null` to send the
 * whole file: no header, a unit other than bytes, a malformed value, or
 * several ranges, which may be answered in full.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size <= 0) return "unsatisfiable";

  if (rawStart === "") {
    // "-N": the last N bytes.
    const suffix = Number(rawEnd);
    if (!(suffix > 0)) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  if (rawEnd === "") return { start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
