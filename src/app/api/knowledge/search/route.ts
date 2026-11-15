import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { readableCollectionIds, searchKnowledge } from "@/lib/knowledge/service";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { knowledgeSearchSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The passages of some collections that best answer a question. */
export const POST = handle(async (req) => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`knowledge:search:${user.id}`, 60, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many searches. Wait a minute and try again.");
  const body = await parseBody(req, knowledgeSearchSchema);
  const ids = readableCollectionIds(body.collectionIds, user);
  if (ids.length === 0) throw Errors.notFound("Collection not found");
  const hits = await searchKnowledge(ids, body.query, { limit: body.limit, userId: user.id });
  return json({ hits });
});
