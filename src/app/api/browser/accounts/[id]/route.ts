import { eq } from "drizzle-orm";
import { db } from "@/db";
import { siteAccounts } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireAdmin, requireOwner } from "@/lib/auth";
import { checkedAccount, forgetSession, getAccount, savedAccount, serializeAccount } from "@/lib/browser/accounts";
import { ONLY_OWNER, mayUseAccount, siteHost } from "@/lib/browser/rules";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { siteAccountUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireAdmin();
  const row = savedAccount(params.id!);
  // The same answer for an account that is not there and for one this user may not use.
  if (!row || !mayUseAccount(user.role, row.access)) throw Errors.notFound("Site account not found");
  return json({ account: serializeAccount(row) });
});

/** Change an account. With a new password, a new user name or another site, the session that was kept is dropped. */
export const PATCH = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const existing = savedAccount(params.id!);
  if (!existing) throw Errors.notFound("Site account not found");
  const body = await parseBody(req, siteAccountUpdateSchema);
  const { values, signInChanged } = checkedAccount(body, existing);
  const row = db
    .update(siteAccounts)
    .set({ ...values, ...(signInChanged ? { lastProblem: null } : {}), updatedAt: new Date() })
    .where(eq(siteAccounts.id, existing.id))
    .returning()
    .get();
  if (signInChanged) forgetSession(existing.id);
  audit({
    actorUserId: user.id,
    action: "site_account.update",
    targetType: "site_account",
    targetId: row.id,
    metadata: {
      name: row.name,
      site: siteHost(row.siteUrl),
      username: row.username,
      access: row.access,
      status: row.status,
      // What was changed, never to what: a password is not written down.
      changed: Object.keys(body).map((key) => (key === "password" ? "password" : key)),
      ...(signInChanged ? { sessionDropped: true } : {}),
    },
    ip,
    userAgent,
  });
  return json({ account: serializeAccount(getAccount(row.id) ?? row), sessionDropped: signInChanged && Boolean(existing.sessionCiphertext) });
});

/** Remove an account. The projects that named it are without it; what was done with it stays in the log. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const existing = savedAccount(params.id!);
  if (!existing) throw Errors.notFound("Site account not found");
  db.delete(siteAccounts).where(eq(siteAccounts.id, existing.id)).run();
  audit({
    actorUserId: user.id,
    action: "site_account.delete",
    targetType: "site_account",
    targetId: existing.id,
    metadata: { name: existing.name, site: siteHost(existing.siteUrl) },
    ip,
    userAgent,
  });
  return json({ ok: true });
});
