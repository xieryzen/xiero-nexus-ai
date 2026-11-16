import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  deleteCollection,
  listDocuments,
  loadManagedCollection,
  loadReadableCollection,
  serializeCollection,
  updateCollection,
} from "@/lib/knowledge/service";
import { getClientMeta } from "@/lib/request";
import { collectionUpdateSchema } from "@/lib/validation";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** A collection and its documents. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const collection = loadReadableCollection(params.id!, user);
  return json({
    collection: serializeCollection(collection, user),
    documents: listDocuments(collection.id, user.role),
  });
});

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const collection = loadManagedCollection(params.id!, user);
  const body = await parseBody(req, collectionUpdateSchema);
  const updated = updateCollection(collection, body, user);
  audit({
    actorUserId: user.id,
    action: "knowledge.collection.update",
    targetType: "knowledge",
    targetId: collection.id,
    metadata: { fields: Object.keys(body), visibility: updated.visibility },
    ip,
    userAgent,
  });
  // A new embedding model means the documents are embedded again.
  kickWorker();
  return json({ collection: serializeCollection(updated, user) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const collection = loadManagedCollection(params.id!, user);
  deleteCollection(collection);
  audit({
    actorUserId: user.id,
    action: "knowledge.collection.delete",
    targetType: "knowledge",
    targetId: collection.id,
    metadata: { name: collection.name },
    ip,
    userAgent,
  });
  return json({ ok: true });
});
