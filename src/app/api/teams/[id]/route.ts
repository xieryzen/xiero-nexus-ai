import { eq } from "drizzle-orm";
import { db } from "@/db";
import { teamAgents, teams } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { serializeTeam } from "@/lib/workforce";
import { teamUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const PATCH = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = db.select().from(teams).where(eq(teams.id, params.id!)).get();
  if (!existing) throw Errors.notFound("Team not found");
  const body = await parseBody(req, teamUpdateSchema);

  db.transaction((tx) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description ?? null;
    tx.update(teams).set(patch).where(eq(teams.id, existing.id)).run();
    if (body.agentIds !== undefined) {
      tx.delete(teamAgents).where(eq(teamAgents.teamId, existing.id)).run();
      for (const agentId of [...new Set(body.agentIds)]) {
        tx.insert(teamAgents).values({ teamId: existing.id, agentId }).run();
      }
    }
  });

  audit({ actorUserId: user.id, action: "team.update", targetType: "team", targetId: existing.id, ip, userAgent });
  const fresh = db.select().from(teams).where(eq(teams.id, existing.id)).get()!;
  return json({ team: serializeTeam(fresh) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = db.select().from(teams).where(eq(teams.id, params.id!)).get();
  if (!existing) throw Errors.notFound("Team not found");
  db.delete(teams).where(eq(teams.id, existing.id)).run();
  audit({ actorUserId: user.id, action: "team.delete", targetType: "team", targetId: existing.id, metadata: { name: existing.name }, ip, userAgent });
  return json({ ok: true });
});
