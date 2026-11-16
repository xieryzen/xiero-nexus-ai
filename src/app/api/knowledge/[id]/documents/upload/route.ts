import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError, Errors } from "@/lib/errors";
import { MAX_DOCUMENT_BYTES } from "@/lib/knowledge/extract";
import { addFileDocument } from "@/lib/knowledge/ingest";
import { loadManagedCollection, serializeDocument } from "@/lib/knowledge/service";
import { readBodyCapped } from "@/lib/media/http";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/**
 * Upload a document: text, Markdown, CSV, JSON, HTML, PDF or .docx. The body
 * is the file itself; its name comes in the `x-file-name` header
 * (URL-encoded). Only the text of the file is kept, not the file.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const collection = loadManagedCollection(params.id!, user);
  maybeSweep();
  const limit = rateLimit(`knowledge:add:${user.id}`, 60, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many documents at once. Wait a minute and try again.");

  let bytes: Buffer;
  try {
    bytes = await readBodyCapped(req, { maxBytes: MAX_DOCUMENT_BYTES, timeoutMs: 120_000 });
  } catch (err) {
    if (err instanceof AppError && err.code === "upstream_too_large") {
      throw new AppError(
        413,
        "too_large",
        `A document can be at most ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`,
      );
    }
    throw Errors.badRequest("The upload did not arrive completely. Try again.");
  }
  let name = "";
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") ?? "");
  } catch {
    name = "";
  }
  const doc = await addFileDocument(collection, user.id, { name, bytes });
  kickWorker();
  return json({ document: serializeDocument(doc, user.role) }, { status: 201 });
});
