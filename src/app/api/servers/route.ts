import { db } from "@/db";
import { servers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireAdmin, requireOwner } from "@/lib/auth";
import { ONLY_OWNER } from "@/lib/ssh/rules";
import { getClientMeta } from "@/lib/request";
import { auditFields, checkedServer, limitConnections } from "@/lib/ssh/register";
import { managesServers } from "@/lib/ssh/rules";
import { logCommand, serializeServer, serversFor } from "@/lib/ssh/servers";
import { openSessions } from "@/lib/ssh/sessions";
import { serverCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The machines the projects of this account may work on: all of them for an
 * owner, the ones opened to administrators for an administrator. Never with
 * what signs in to them.
 */
export const GET = handle(async () => {
  const user = requireAdmin();
  const open = openSessions();
  return json({
    servers: serversFor(user).map((row) => ({
      ...serializeServer(row),
      // The runs that hold a connection to it at this moment.
      open: open.filter((s) => s.serverId === row.id).map(({ serverId: _serverId, ...rest }) => rest),
    })),
    canManage: managesServers(user.role),
  });
});

/**
 * Register a machine. The app signs in once, to the machine that shows the
 * host key the owner accepted, and runs one harmless command; only then is
 * anything saved.
 */
export const POST = handle(async (req) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, serverCreateSchema);
  limitConnections(user);
  const { values, checked } = await checkedServer(body);
  const row = db
    .insert(servers)
    .values({ ...values, lastConnectedAt: new Date(), createdBy: user.id })
    .returning()
    .get();
  audit({ actorUserId: user.id, action: "server.create", targetType: "server", targetId: row.id, metadata: auditFields(row), ip, userAgent });
  logCommand({ server: row, kind: "test", userId: user.id, command: "Registered: signed in and ran one command", status: "ok", output: checked });
  return json({ server: serializeServer(row), checked }, { status: 201 });
});
