import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { addLinkDocument, addTextDocument } from "@/lib/knowledge/ingest";
import {
  listDocuments,
  loadManagedCollection,
  loadReadableCollection,
  serializeDocument,
} from "@/lib/knowledge/service";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { documentCreateSchema } from "@/lib/validation";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const collection = loadReadableCollection(params.id!, user);
  return json({ documents: listDocuments(collection.id, user.role) });
});

/**
 * Add a document: { title, text } for text typed or pasted in, or { url } for
 * a public page or file, which the server fetches. Files are uploaded to
 * …/documents/upload.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const collection = loadManagedCollection(params.id!, user);
  maybeSweep();
  const limit = rateLimit(`knowledge:add:${user.id}`, 60, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many documents at once. Wait a minute and try again.");
  const body = await parseBody(req, documentCreateSchema);
  const doc =
    "url" in body
      ? await addLinkDocument(collection, user.id, body)
      : addTextDocument(collection, user.id, body);
  kickWorker();
  return json({ document: serializeDocument(doc, user.role) }, { status: 201 });
});
