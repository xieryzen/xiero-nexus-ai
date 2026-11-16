import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { clearMemories, listMemories, rememberNote } from "@/lib/agent/memory";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { memoryCreateSchema } from "@/lib/validation";
import { isAdminRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

function loadAgent(id: string) {
  const agent = db.select().from(agents).where(eq(agents.id, id)).get();
  if (!agent) throw Errors.notFound("Agent not found");
  return agent;
}

/**
 * The notes an agent has kept. A user sees the ones from their own projects
 * and the ones that apply to everyone; an administrator sees all of them.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const agent = loadAgent(params.id!);
  return json({
    memoryEnabled: agent.memoryEnabled,
    memories: listMemories(agent.id, isAdminRole(user.role) ? undefined : user.id),
  });
});

/** Add a note by hand. It applies in everyone's projects, so only an administrator can. */
export const POST = handle(async (req, { params }) => {
  const admin = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const agent = loadAgent(params.id!);
  const body = await parseBody(req, memoryCreateSchema);
  const saved = rememberNote(agent.id, body.content, { userId: admin.id, source: "manual" });
  if (!saved) throw Errors.badRequest("The note is empty");
  audit({ actorUserId: admin.id, action: "agent.memory.add", targetType: "agent", targetId: agent.id, ip, userAgent });
  return json({ created: saved.created }, { status: saved.created ? 201 : 200 });
});

/** Forget: a user their own notes, an administrator all of the agent's. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const agent = loadAgent(params.id!);
  const removed = clearMemories(agent.id, isAdminRole(user.role) ? undefined : user.id);
  audit({
    actorUserId: user.id,
    action: "agent.memory.clear",
    targetType: "agent",
    targetId: agent.id,
    metadata: { removed },
    ip,
    userAgent,
  });
  return json({ removed });
});
