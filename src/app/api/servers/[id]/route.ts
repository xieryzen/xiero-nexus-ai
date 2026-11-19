import { eq } from "drizzle-orm";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireAdmin, requireOwner } from "@/lib/auth";
import { ONLY_OWNER } from "@/lib/ssh/rules";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { auditFields, checkedServer, limitConnections } from "@/lib/ssh/register";
import { mayUseServer } from "@/lib/ssh/rules";
import { getServer, logCommand, serializeServer } from "@/lib/ssh/servers";
import { serverUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireAdmin();
  const row = getServer(params.id!);
  // The same answer for a machine that is not there and for one this account may not use.
  if (!row || !mayUseServer(user.role, row.access)) throw Errors.notFound("Server not found");
  return json({ server: serializeServer(row) });
});

/**
 * Change a machine. When where it is or what signs in changes, the app signs
 * in once with the new values before they are saved, as when it was
 * registered.
 */
export const PATCH = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const existing = getServer(params.id!);
  if (!existing) throw Errors.notFound("Server not found");
  const body = await parseBody(req, serverUpdateSchema);
  limitConnections(user);
  const { values, checked, connectionChanged } = await checkedServer(body, existing);
  const row = db
    .update(servers)
    .set({
      ...values,
      updatedAt: new Date(),
      ...(connectionChanged ? { lastConnectedAt: new Date(), lastError: null } : {}),
    })
    .where(eq(servers.id, existing.id))
    .returning()
    .get();
  audit({
    actorUserId: user.id,
    action: "server.update",
    targetType: "server",
    targetId: row.id,
    // What was asked to change, by name; what signs in is never written down.
    metadata: { ...auditFields(row), changed: Object.keys(body).sort() },
    ip,
    userAgent,
  });
  if (connectionChanged) {
    logCommand({ server: row, kind: "test", userId: user.id, command: "Changed: signed in and ran one command", status: "ok", output: checked });
  }
  return json({ server: serializeServer(row), checked });
});

/** Remove a machine. The projects that named it lose it; what was done on it stays in the log. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const existing = getServer(params.id!);
  if (!existing) throw Errors.notFound("Server not found");
  db.delete(servers).where(eq(servers.id, existing.id)).run();
  audit({ actorUserId: user.id, action: "server.delete", targetType: "server", targetId: existing.id, metadata: auditFields(existing), ip, userAgent });
  return json({ ok: true });
});
