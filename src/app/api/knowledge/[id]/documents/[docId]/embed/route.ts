import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadManagedCollection, retryEmbedding } from "@/lib/knowledge/service";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Embed a document again, after it failed. */
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  const collection = loadManagedCollection(params.id!, user);
  retryEmbedding(collection, params.docId!, user.id);
  kickWorker();
  return json({ ok: true });
});
