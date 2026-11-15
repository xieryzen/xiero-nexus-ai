import "server-only";
import type { KnowledgeCollection, KnowledgeDocument } from "@/db/schema";
import { AppError, Errors } from "../errors";
import { fetchWeb } from "../web-fetch";
import { ExtractError, MAX_DOCUMENT_BYTES, extractDocument } from "./extract";
import { readPdf } from "./pdf";
import { addDocument } from "./service";

/** Adding documents to a collection: from a file, from pasted text, from a link. */

function titleFromName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]{1,8}$/, "");
  return base.replace(/[_-]+/g, " ").trim() || "Untitled";
}

async function extract(name: string, bytes: Uint8Array) {
  try {
    return await extractDocument(name, bytes, { readPdf });
  } catch (err) {
    if (err instanceof ExtractError) throw Errors.badRequest(err.message);
    throw err;
  }
}

export async function addFileDocument(
  collection: KnowledgeCollection,
  userId: string,
  file: { name: string; bytes: Uint8Array; title?: string },
): Promise<KnowledgeDocument> {
  const name = file.name.replace(/[\u0000-\u001f]/g, " ").trim() || "document";
  const doc = await extract(name, file.bytes);
  return addDocument(collection, userId, {
    title: file.title?.trim() || doc.title || titleFromName(name),
    sourceType: "upload",
    sourceName: name,
    mimeType: doc.mimeType,
    sizeBytes: file.bytes.byteLength,
    text: doc.text,
  });
}

export function addTextDocument(
  collection: KnowledgeCollection,
  userId: string,
  input: { title: string; text: string },
): KnowledgeDocument {
  return addDocument(collection, userId, {
    title: input.title,
    sourceType: "text",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(input.text),
    text: input.text,
  });
}

/** Fetch a public page or file and add what it says. */
export async function addLinkDocument(
  collection: KnowledgeCollection,
  userId: string,
  input: { url: string; title?: string },
): Promise<KnowledgeDocument> {
  const res = await fetchWeb(input.url, {
    headers: { accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
    maxBytes: MAX_DOCUMENT_BYTES,
    maxRedirects: 4,
    timeoutMs: 30_000,
  });
  if (res.status >= 400) {
    throw new AppError(502, "upstream_error", `The address answered ${res.status}`);
  }
  // The address decides how the file is read when it has an extension; a page has none.
  const path = new URL(res.url).pathname;
  const name = /\.[A-Za-z0-9]{1,8}$/.test(path)
    ? path.slice(path.lastIndexOf("/") + 1)
    : /html/.test(res.contentType)
      ? "page.html"
      : "page";
  const doc = await extract(name, res.bytes);
  return addDocument(collection, userId, {
    title: input.title?.trim() || doc.title || titleFromName(name === "page" || name === "page.html" ? new URL(res.url).hostname : name),
    sourceType: "url",
    sourceName: res.url,
    mimeType: doc.mimeType,
    sizeBytes: res.bytes.byteLength,
    text: doc.text,
  });
}
