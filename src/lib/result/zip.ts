import { createReadStream } from "node:fs";
import { deflateRawSync } from "node:zlib";

/**
 * A ZIP archive written as a stream: what a project made, as one download.
 * Text is compressed; a file on disk (a built package, a picture, a video)
 * is put in as it is, read twice and never held in memory. No ZIP64, so the
 * archive stays under 4 GB and 65,535 entries: `zipFits` says whether it does.
 */

export type ZipSource =
  | { path: string; data: Buffer; modified?: Date }
  | { path: string; file: string; size: number; modified?: Date };

/** The largest archive that is written, with room for its own headers. */
export const ZIP_MAX_BYTES = 3_500_000_000;
export const ZIP_MAX_ENTRIES = 60_000;

export function zipFits(sources: readonly ZipSource[]): boolean {
  if (sources.length > ZIP_MAX_ENTRIES) return false;
  let total = 0;
  for (const source of sources) total += "data" in source ? source.data.length : source.size;
  return total <= ZIP_MAX_BYTES;
}

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  return table;
}

/** CRC-32 over more than one piece: start with 0xffffffff, end with `crcEnd`. */
export function crcUpdate(crc: number, data: Uint8Array): number {
  const t = crcTable();
  let c = crc;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

export function crcEnd(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** A path as an archive holds it: forward slashes, never absolute, never leaving the folder. */
export function archivePath(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  const path = parts.join("/");
  return Buffer.byteLength(path, "utf8") > 0xffff ? null : path;
}

interface Written {
  name: Buffer;
  method: number;
  crc: number;
  packed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

function localHeader(entry: Written): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // names are UTF-8
  head.writeUInt16LE(entry.method, 8);
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.date, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.packed, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(entry.name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, entry.name]);
}

function centralHeader(entry: Written): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(0x0314, 4); // made on Unix, version 2.0
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(entry.method, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.packed, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(0, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  head.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a plain file anyone may read
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, entry.name]);
}

async function crcOfFile(file: string): Promise<{ crc: number; size: number }> {
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = chunk as Buffer;
    crc = crcUpdate(crc, bytes);
    size += bytes.length;
  }
  return { crc: crcEnd(crc), size };
}

async function* write(sources: readonly ZipSource[]): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  const seen = new Set<string>();
  let offset = 0;
  const now = new Date();
  for (const source of sources) {
    const path = archivePath(source.path);
    // A name is in an archive once: the first one stays.
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const stamp = dosTime(source.modified ?? now);
    const name = Buffer.from(path, "utf8");
    if ("data" in source) {
      const packed = deflateRawSync(source.data, { level: 6 });
      // What does not get smaller is put in as it is.
      const store = packed.length >= source.data.length;
      const body = store ? source.data : packed;
      const entry: Written = {
        name,
        method: store ? 0 : 8,
        crc: crcEnd(crcUpdate(0xffffffff, source.data)),
        packed: body.length,
        size: source.data.length,
        offset,
        ...stamp,
      };
      const head = localHeader(entry);
      yield head;
      if (body.length > 0) yield body;
      offset += head.length + body.length;
      written.push(entry);
      continue;
    }
    let measured: { crc: number; size: number };
    try {
      measured = await crcOfFile(source.file);
    } catch {
      // A file that is gone is left out; the archive holds the rest.
      seen.delete(path);
      continue;
    }
    const entry: Written = { name, method: 0, crc: measured.crc, packed: measured.size, size: measured.size, offset, ...stamp };
    const head = localHeader(entry);
    yield head;
    let sent = 0;
    for await (const chunk of createReadStream(source.file, { end: Math.max(0, measured.size - 1) })) {
      if (measured.size === 0) break;
      const bytes = chunk as Buffer;
      sent += bytes.length;
      yield bytes;
    }
    // A file that became shorter in between: the entry is filled up to the size it announced.
    if (sent < measured.size) yield Buffer.alloc(measured.size - sent);
    offset += head.length + measured.size;
    written.push(entry);
  }
  const start = offset;
  let size = 0;
  for (const entry of written) {
    const head = centralHeader(entry);
    size += head.length;
    yield head;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(written.length, 8);
  end.writeUInt16LE(written.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(start, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

/** The archive of these files, as a stream of its bytes. */
export function zipStream(sources: readonly ZipSource[]): ReadableStream<Uint8Array> {
  const pieces = write(sources);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await pieces.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await pieces.return(undefined);
    },
  });
}

/** The archive of these files in memory: for small archives, and for tests. */
export async function zipBuffer(sources: readonly ZipSource[]): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const piece of write(sources)) parts.push(piece);
  return Buffer.concat(parts);
}
