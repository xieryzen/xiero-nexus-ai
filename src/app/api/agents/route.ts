import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, models } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { modelIsMediaOnly } from "@/lib/gateway";
import { getClientMeta } from "@/lib/request";
import { serializeAgent, serializeAgents } from "@/lib/workforce";
import { agentCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function assertModelExists(id: string | null | undefined) {
  if (!id) return;
  const m = db.select({ id: models.id }).from(models).where(eq(models.id, id)).get();
  if (!m) throw Errors.badRequest("Selected model does not exist");
  // An agent thinks in text, also when its task is to write an image prompt.
  if (modelIsMediaOnly(id)) {
    throw Errors.badRequest("An image or video model cannot be an agent's model. Choose a chat model.");
  }
}

export const GET = handle(async () => {
  requireUser();
  const rows = db.select().from(agents).orderBy(asc(agents.name)).all();
  return json({ agents: serializeAgents(rows) });
});

export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, agentCreateSchema);
  assertModelExists(body.primaryModelRowId);
  assertModelExists(body.fallbackModelRowId);

  const agent = db
    .insert(agents)
    .values({
      name: body.name,
      role: body.role,
      instructions: body.instructions ?? "",
      primaryModelRowId: body.primaryModelRowId ?? null,
      fallbackModelRowId: body.fallbackModelRowId ?? null,
      routingMode: body.routingMode ?? "manual",
      requiredCapability: body.requiredCapability ?? null,
      temperature: body.temperature ?? 0.7,
      createdBy: user.id,
    })
    .returning()
    .get();

  audit({
    actorUserId: user.id,
    action: "agent.create",
    targetType: "agent",
    targetId: agent.id,
    metadata: { name: agent.name, role: agent.role },
    ip,
    userAgent,
  });
  return json({ agent: serializeAgent(agent) }, { status: 201 });
});
