import { teamFor } from "@/lib/for-viewer";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { teamAgents, teams } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { setTeamSkills } from "@/lib/skills/service";
import { serializeTeam } from "@/lib/workforce";
import { teamCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  const rows = db.select().from(teams).orderBy(asc(teams.name)).all();
  return json({ teams: rows.map((team) => teamFor(user.role, serializeTeam(team))) });
});

export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, teamCreateSchema);

  const team = db.transaction((tx) => {
    const t = tx
      .insert(teams)
      .values({ name: body.name, description: body.description ?? null, createdBy: user.id })
      .returning()
      .get();
    for (const agentId of [...new Set(body.agentIds ?? [])]) {
      tx.insert(teamAgents).values({ teamId: t.id, agentId }).run();
    }
    return t;
  });
  if (body.skillIds?.length) {
    try {
      setTeamSkills(team.id, body.skillIds);
    } catch (err) {
      // Not half a team.
      db.delete(teams).where(eq(teams.id, team.id)).run();
      throw err;
    }
  }

  audit({ actorUserId: user.id, action: "team.create", targetType: "team", targetId: team.id, metadata: { name: team.name }, ip, userAgent });
  return json({ team: serializeTeam(team) }, { status: 201 });
});
