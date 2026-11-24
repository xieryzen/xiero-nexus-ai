import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { createCollection, listCollections, serializeCollection } from "@/lib/knowledge/service";
import { assertFeature } from "@/lib/plans";
import { getClientMeta } from "@/lib/request";
import { collectionCreateSchema } from "@/lib/validation";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** The knowledge collections the user can read: their own and the shared ones. */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ collections: listCollections(user) });
});

export const POST = handle(async (req) => {
  const user = requireUser();
  assertFeature(user, "knowledge");
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, collectionCreateSchema);
  const collection = createCollection(user, body);
  audit({
    actorUserId: user.id,
    action: "knowledge.collection.create",
    targetType: "knowledge",
    targetId: collection.id,
    metadata: { name: collection.name, visibility: collection.visibility },
    ip,
    userAgent,
  });
  kickWorker();
  return json({ collection: serializeCollection(collection, user) }, { status: 201 });
});
