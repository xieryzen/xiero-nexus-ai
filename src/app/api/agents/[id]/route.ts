import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, models } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { memoryCounts } from "@/lib/agent/memory";
import { Errors } from "@/lib/errors";
import { modelIsMediaOnly } from "@/lib/gateway";
import { collectionIdsForAgent, setAgentCollections } from "@/lib/knowledge/service";
import { getClientMeta } from "@/lib/request";
import { setAgentSkills, skillIdsForAgent } from "@/lib/skills/service";
import { serializeAgent } from "@/lib/workforce";
import { agentUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function assertModelExists(id: string | null | undefined) {
  if (!id) return;
  const m = db.select({ id: models.id }).from(models).where(eq(models.id, id)).get();
  if (!m) throw Errors.badRequest("Selected model does not exist");
  // An agent thinks in text, also when its task is to write an image prompt.
  if (modelIsMediaOnly(id)) {
    throw Errors.badRequest("A media or embedding model cannot be an agent's model. Choose a chat model.");
  }
}

export const PATCH = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = db.select().from(agents).where(eq(agents.id, params.id!)).get();
  if (!existing) throw Errors.notFound("Agent not found");
  const body = await parseBody(req, agentUpdateSchema);
  assertModelExists(body.primaryModelRowId);
  assertModelExists(body.fallbackModelRowId);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of ["name", "role", "instructions", "temperature", "status", "routingMode"] as const) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (body.primaryModelRowId !== undefined) patch.primaryModelRowId = body.primaryModelRowId;
  if (body.fallbackModelRowId !== undefined) patch.fallbackModelRowId = body.fallbackModelRowId;
  if (body.requiredCapability !== undefined) patch.requiredCapability = body.requiredCapability;
  if (body.tools !== undefined) patch.tools = JSON.stringify(body.tools);
  if (body.maxSteps !== undefined) patch.maxSteps = body.maxSteps;
  if (body.memoryEnabled !== undefined) patch.memoryEnabled = body.memoryEnabled;

  // Checked first: they can refuse, and then nothing is changed.
  if (body.collectionIds !== undefined) setAgentCollections(existing.id, body.collectionIds);
  if (body.skillIds !== undefined) setAgentSkills(existing.id, body.skillIds);
  db.update(agents).set(patch).where(eq(agents.id, existing.id)).run();
  audit({
    actorUserId: user.id,
    action: "agent.update",
    targetType: "agent",
    targetId: existing.id,
    // What an agent may do, and what it works by, is worth a line in the log of its own.
    metadata:
      body.tools !== undefined || body.skillIds !== undefined
        ? { ...(body.tools !== undefined ? { tools: body.tools } : {}), ...(body.skillIds !== undefined ? { skills: body.skillIds.length } : {}) }
        : undefined,
    ip,
    userAgent,
  });

  const fresh = db.select().from(agents).where(eq(agents.id, existing.id)).get()!;
  return json({
    agent: serializeAgent(fresh, undefined, {
      collectionIds: collectionIdsForAgent(fresh.id),
      skillIds: skillIdsForAgent(fresh.id),
      memoryCount: memoryCounts().get(fresh.id),
    }),
  });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = db.select().from(agents).where(eq(agents.id, params.id!)).get();
  if (!existing) throw Errors.notFound("Agent not found");
  db.delete(agents).where(eq(agents.id, existing.id)).run();
  audit({ actorUserId: user.id, action: "agent.delete", targetType: "agent", targetId: existing.id, metadata: { name: existing.name }, ip, userAgent });
  return json({ ok: true });
});
