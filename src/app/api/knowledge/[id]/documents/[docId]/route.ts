import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { deleteDocument, loadManagedCollection } from "@/lib/knowledge/service";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const collection = loadManagedCollection(params.id!, user);
  deleteDocument(collection, params.docId!);
  return json({ ok: true });
});
