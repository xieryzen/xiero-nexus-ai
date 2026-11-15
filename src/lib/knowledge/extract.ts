import { inflateRawSync } from "node:zlib";
import { decodeEntities, htmlToText, looksLikeHtml } from "../text/html";

/**
 * Text out of an uploaded document. No database or framework imports, so it
 * can be unit-tested. Handles plain text and source files, Markdown, CSV,
 * JSON, HTML, Word (.docx) and PDF.
 */

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 2_000_000;

export class ExtractError extends Error {}

/** Extensions read as text as they are. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "log",
  "ini", "toml", "env", "sql", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "css", "scss", "vue", "svelte", "tex",
  "srt", "vtt",
]);

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/** Decode bytes as text: UTF-8, or UTF-16 when a byte-order mark says so. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder("utf-8").decode(bytes.subarray(start));
}

/** True when bytes are not text: they hold NUL bytes or many control characters. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.length === 0) return false;
  let odd = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return odd / sample.length > 0.1;
}

// ─── ZIP (for .docx) ─────────────────────────────────────────────────────────

/** Largest entry unpacked from an archive. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * One file out of a ZIP archive, or null when it is not in it. Reads the
 * central directory at the end of the archive; handles stored and deflated
 * entries, which is all a .docx uses.
 */
export function readZipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ExtractError("The file is not a valid archive");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    if (offset + 46 > zip.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ExtractError("The file is not a valid archive");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entryName = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));

    if (entryName === name) {
      if (size > MAX_ENTRY_BYTES) throw new ExtractError("The document is too large to read");
      if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new ExtractError("The file is not a valid archive");
      }
      const dataStart =
        localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) {
        return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
      }
      throw new ExtractError("The document uses a compression this app cannot read");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** The text of a Word document's main part. */
export function docxXmlToText(xml: string): string {
  const paragraphs: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    let line = "";
    const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
    for (;;) {
      const match = pattern.exec(para);
      if (!match) break;
      if (match[1] !== undefined) line += decodeEntities(match[1]);
      else if (match[0].startsWith("<w:tab")) line += "\t";
      else line += "\n";
    }
    paragraphs.push(line.trimEnd());
  }
  return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function fromDocx(bytes: Uint8Array): string {
  let xml: Uint8Array | null;
  try {
    xml = readZipEntry(bytes, "word/document.xml");
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError("The Word document could not be read");
  }
  if (!xml) throw new ExtractError("The file is not a Word document (.docx)");
  return docxXmlToText(new TextDecoder().decode(xml));
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

export type PdfReader = (bytes: Uint8Array) => Promise<string>;

export interface ExtractedDocument {
  text: string;
  /** A title found in the document itself, when it has one. */
  title?: string;
  mimeType: string;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Read a document. `readPdf` does the PDF work (it needs a library, which the
 * caller loads); without it a PDF is refused.
 */
export async function extractDocument(
  fileName: string,
  bytes: Uint8Array,
  opts: { readPdf?: PdfReader } = {},
): Promise<ExtractedDocument> {
  if (bytes.byteLength === 0) throw new ExtractError("The file is empty");
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ExtractError(`The file is larger than ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`);
  }
  const ext = extensionOf(fileName);
  let out: ExtractedDocument;

  if (isPdf(bytes)) {
    if (!opts.readPdf) throw new ExtractError("PDF files cannot be read on this server");
    let text: string;
    try {
      text = await opts.readPdf(bytes);
    } catch {
      throw new ExtractError("The PDF could not be read. It may be damaged or protected by a password.");
    }
    if (!text.trim()) {
      throw new ExtractError(
        "No text was found in the PDF. It is probably a scan: its pages are pictures, which this app does not read.",
      );
    }
    out = { text, mimeType: "application/pdf" };
  } else if (isZip(bytes)) {
    if (ext !== "docx" && ext !== "docm" && ext !== "") {
      throw new ExtractError(`.${ext} files are not supported. Use text, Markdown, CSV, JSON, HTML, PDF or .docx.`);
    }
    out = {
      text: fromDocx(bytes),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  } else {
    if (looksBinary(bytes)) {
      throw new ExtractError(
        ext === "doc"
          ? "Old Word files (.doc) are not supported. Save the document as .docx or PDF."
          : "This file is not text. Use text, Markdown, CSV, JSON, HTML, PDF or .docx.",
      );
    }
    const text = decodeText(bytes);
    if (ext === "html" || ext === "htm" || ext === "xhtml" || (!TEXT_EXTENSIONS.has(ext) && looksLikeHtml(text))) {
      const page = htmlToText(text);
      out = { text: page.text, title: page.title || undefined, mimeType: "text/html" };
    } else {
      out = {
        text,
        mimeType:
          ext === "md" || ext === "markdown"
            ? "text/markdown"
            : ext === "csv"
              ? "text/csv"
              : ext === "json"
                ? "application/json"
                : "text/plain",
      };
    }
  }

  out.text = out.text.replace(/\u0000/g, "").trim();
  if (!out.text) throw new ExtractError("No text was found in the file");
  if (out.text.length > MAX_DOCUMENT_CHARS) {
    throw new ExtractError(
      `The document has more than ${MAX_DOCUMENT_CHARS.toLocaleString("en-US")} characters of text. Split it into smaller files.`,
    );
  }
  return out;
}
