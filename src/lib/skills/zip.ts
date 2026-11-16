import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Reading and writing ZIP archives, as far as a skill needs it: a .skill file
 * is a ZIP of a folder with a SKILL.md in it. Pure, and careful: an archive is
 * something a person uploaded, so nothing in it is trusted. Names that leave
 * the folder are refused, sizes are checked before anything is unpacked, and
 * what is unpacked can never be more than was announced.
 *
 * Not supported, and said so: encrypted entries, ZIP64 (archives over 4 GB or
 * with more than 65,535 entries) and compression other than "deflate".
 */

export class ZipError extends Error {}

export interface ZipLimits {
  /** Most entries an archive may list. */
  maxEntries: number;
  /** Most bytes one entry may unpack to. Larger entries are left out. */
  maxEntryBytes: number;
  /** Most bytes all entries together may unpack to. */
  maxTotalBytes: number;
}

export interface ZipEntry {
  /** The path inside the archive, with forward slashes, never absolute, never with "..". */
  path: string;
  data: Buffer;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  /** Entries that were not unpacked, each with the reason. */
  leftOut: { path: string; reason: string }[];
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

let crcTable: Uint32Array | null = null;

/** CRC-32 as ZIP uses it. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Whether these bytes begin like a ZIP archive. */
export function looksLikeZip(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06))
  );
}

/**
 * A path from an archive as a safe relative path, or null when it is not one:
 * absolute, with a drive letter, with ".." in it, or with a control character.
 */
export function safeArchivePath(raw: string): string | null {
  const unified = raw.replace(/\\/g, "/");
  if (unified.length === 0 || unified.length > 400) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(unified)) return null;
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function findEndRecord(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let at = buf.length - EOCD_MIN; at >= lowest; at--) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE && at + EOCD_MIN + buf.readUInt16LE(at + 20) <= buf.length) {
      return at;
    }
  }
  return -1;
}

/** Unpack an archive, within the limits. Throws ZipError when it is not an archive this can read. */
export function readZip(buf: Buffer, limits: ZipLimits): ZipReadResult {
  if (buf.length < EOCD_MIN) throw new ZipError("This is not a ZIP archive.");
  const end = findEndRecord(buf);
  if (end < 0) throw new ZipError("This is not a ZIP archive, or it is cut off.");
  const count = buf.readUInt16LE(end + 10);
  const directorySize = buf.readUInt32LE(end + 12);
  const directoryAt = buf.readUInt32LE(end + 16);
  if (buf.readUInt16LE(end + 4) !== 0 || buf.readUInt16LE(end + 6) !== 0 || buf.readUInt16LE(end + 8) !== count) {
    throw new ZipError("An archive in several parts cannot be read.");
  }
  if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
    throw new ZipError("This archive is in the ZIP64 format, which is for archives far larger than a skill.");
  }
  if (count > limits.maxEntries) {
    throw new ZipError(`The archive lists ${count} entries; at most ${limits.maxEntries} are read.`);
  }
  if (directoryAt + directorySize > end) throw new ZipError("The archive's table of contents is damaged.");

  // First what the archive says of itself, then the unpacking: an archive
  // that announces more than is allowed is refused before any work is done.
  interface Listed {
    path: string | null;
    raw: string;
    method: number;
    flags: number;
    crc: number;
    packed: number;
    size: number;
    localAt: number;
    directory: boolean;
    link: boolean;
  }
  const listed: Listed[] = [];
  let at = directoryAt;
  let announced = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipError("The archive's table of contents is damaged.");
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const attributes = buf.readUInt32LE(at + 38);
    const localAt = buf.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extraLength + commentLength > end) {
      throw new ZipError("The archive's table of contents is damaged.");
    }
    if (packed === 0xffffffff || size === 0xffffffff || localAt === 0xffffffff) {
      throw new ZipError("This archive is in the ZIP64 format, which is for archives far larger than a skill.");
    }
    const raw = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const directory = raw.endsWith("/") || raw.endsWith("\\");
    // The upper half of the attributes is the Unix mode, when the archive was made on Unix.
    const link = ((attributes >>> 16) & 0o170000) === 0o120000;
    listed.push({ path: safeArchivePath(raw), raw, method, flags, crc, packed, size, localAt, directory, link });
    if (!directory) announced += size;
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (announced > limits.maxTotalBytes) {
    throw new ZipError(
      `The archive unpacks to ${Math.ceil(announced / (1024 * 1024))} MB; at most ${Math.floor(limits.maxTotalBytes / (1024 * 1024))} MB is read.`,
    );
  }

  const entries: ZipEntry[] = [];
  const leftOut: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const item of listed) {
    if (item.directory) continue;
    const shown = item.path ?? item.raw.slice(0, 120);
    if (!item.path) {
      leftOut.push({ path: shown, reason: "its path leaves the archive's folder" });
      continue;
    }
    if (item.link) {
      leftOut.push({ path: shown, reason: "it is a link, not a file" });
      continue;
    }
    if (item.flags & 0x1) {
      leftOut.push({ path: shown, reason: "it is encrypted" });
      continue;
    }
    if (item.method !== 0 && item.method !== 8) {
      leftOut.push({ path: shown, reason: "it is packed in a way that is not supported" });
      continue;
    }
    if (item.size > limits.maxEntryBytes) {
      leftOut.push({ path: shown, reason: `it is larger than ${Math.floor(limits.maxEntryBytes / 1024)} KB` });
      continue;
    }
    if (seen.has(item.path)) {
      leftOut.push({ path: shown, reason: "the archive has this path twice" });
      continue;
    }
    if (item.localAt + 30 > buf.length || buf.readUInt32LE(item.localAt) !== LOCAL_SIGNATURE) {
      throw new ZipError(`The archive is damaged at "${shown}".`);
    }
    const dataAt =
      item.localAt + 30 + buf.readUInt16LE(item.localAt + 26) + buf.readUInt16LE(item.localAt + 28);
    if (dataAt + item.packed > buf.length) throw new ZipError(`The archive is cut off at "${shown}".`);
    const packed = buf.subarray(dataAt, dataAt + item.packed);
    let data: Buffer;
    if (item.method === 0) {
      if (item.packed !== item.size) throw new ZipError(`The archive is damaged at "${shown}".`);
      data = Buffer.from(packed);
    } else {
      try {
        // Never more than was announced, whatever the packed bytes would unpack to.
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, item.size) });
      } catch {
        throw new ZipError(`"${shown}" in the archive cannot be unpacked: it is damaged, or larger than it says.`);
      }
      if (data.length !== item.size) throw new ZipError(`The archive is damaged at "${shown}".`);
    }
    if (crc32(data) !== item.crc) throw new ZipError(`The archive is damaged at "${shown}" (checksum).`);
    seen.add(item.path);
    entries.push({ path: item.path, data });
  }
  return { entries, leftOut };
}

/** Pack files into a ZIP archive. Paths are taken as they are: give safe ones. */
export function writeZip(files: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00: the archive of the same files is the same bytes.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const packed = deflateRawSync(file.data, { level: 9 });
    const stored = packed.length >= file.data.length;
    const body = stored ? file.data : packed;
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(EOCD_MIN);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}
