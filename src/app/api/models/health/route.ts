import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { healthStatus, runHealthRound } from "@/lib/model-health";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

/** How the automatic check of the models is set, and what the last round found. */
export const GET = handle(async () => {
  requireAdmin();
  return json({ health: healthStatus() });
});

const runSchema = z.object({
  /** These models only. Without it: every model that can be checked. */
  modelIds: z.array(z.string().min(1).max(100)).min(1).max(500).optional(),
  /** Answer when the round has ended, with what it found. Without it the answer comes at once (202). */
  wait: z.boolean().optional(),
});

/**
 * Check the models now, due or not. A model that fails is left out of the
 * model lists; one that passes is offered again.
 */
export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, runSchema);
  const limit = rateLimit(`models:health:${user.id}`, 30, 10 * 60_000);
  if (!limit.ok) throw Errors.rateLimited("The models were checked several times just now. Wait a few minutes.");
  if (healthStatus().running) throw Errors.conflict("A check of the models is running already.");

  audit({
    actorUserId: user.id,
    action: "model.health.run",
    metadata: { models: body.modelIds ? body.modelIds.length : "all" },
    ip,
    userAgent,
  });
  const work = runHealthRound({ modelIds: body.modelIds, all: !body.modelIds, userId: user.id });
  if (body.wait) {
    const round = await work;
    return json({ health: healthStatus(), round });
  }
  void work.catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] the check of the models stopped:", err);
  });
  return json({ health: healthStatus() }, { status: 202 });
});
