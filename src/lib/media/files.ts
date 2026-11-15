/**
 * Media file rules: what a generated file is allowed to be, what it is called
 * on disk, and how a byte range is read from it. Pure and dependency-free so
 * the rules can be unit-tested.
 */

export type MediaKind = "image" | "video" | "audio";

export interface MediaType {
  kind: MediaKind;
  mime: string;
  ext: string;
}

/** Largest file the gateway will store, per kind. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export function maxBytesFor(kind: MediaKind): number {
  return kind === "image" ? MAX_IMAGE_BYTES : kind === "video" ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
}

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
 * could run script there. MPEG audio without a tag is recognised by its frame header
 * alone, which is a weak signature, so that test comes last.
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
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return { kind: "audio", mime: "audio/wav", ext: "wav" };
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    // The same container also carries still images (HEIC, AVIF).
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return null;
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov" };
    // ... and sound alone (AAC in an MP4 container).
    if (/^(M4A |M4B |F4A )$/.test(brand)) return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
    return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: "video", mime: "video/webm", ext: "webm" };
  }
  if (ascii(bytes, 0, 3) === "ID3") {
    return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  }
  if (ascii(bytes, 0, 4) === "OggS") {
    return { kind: "audio", mime: "audio/ogg", ext: "ogg" };
  }
  if (ascii(bytes, 0, 4) === "fLaC") {
    return { kind: "audio", mime: "audio/flac", ext: "flac" };
  }
  // Frame sync (eleven set bits) of MPEG audio without a tag. The layer bits
  // tell MP3 (layer III, 01) from AAC in ADTS (layer 00).
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    const layer = (bytes[1]! >> 1) & 0x03;
    if (layer === 0x01) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
    if (layer === 0x00 && (bytes[1]! & 0xf0) === 0xf0) {
      return { kind: "audio", mime: "audio/aac", ext: "aac" };
    }
  }
  return null;
}

const FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp|mp4|mov|webm|mp3|wav|ogg|flac|aac|m4a)$/;

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
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
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

/**
 * Wrap headerless PCM samples in a WAV file. Some speech APIs return the bare
 * samples (16-bit, little-endian), which no player opens as they are.
 */
export function pcmToWav(
  pcm: Uint8Array,
  format: { sampleRate: number; channels: number; bitsPerSample: number },
): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true); // size of the format chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  tag(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/**
 * The sample format named by a MIME type such as
 * "audio/L16;codec=pcm;rate=24000", or null when it is not headerless PCM.
 */
export function pcmFormatFromMime(
  mime: string | null | undefined,
): { sampleRate: number; channels: number; bitsPerSample: number } | null {
  if (!mime) return null;
  const lower = mime.toLowerCase();
  const bits = lower.match(/^audio\/l(8|16|24|32)\b/);
  if (!bits && !/codec=pcm/.test(lower) && !lower.startsWith("audio/pcm")) return null;
  const rate = lower.match(/rate=(\d{4,6})/);
  const channels = lower.match(/channels=(\d)/);
  return {
    sampleRate: rate ? Number(rate[1]) : 24_000,
    channels: channels ? Math.max(1, Number(channels[1])) : 1,
    bitsPerSample: bits ? Number(bits[1]) : 16,
  };
}
