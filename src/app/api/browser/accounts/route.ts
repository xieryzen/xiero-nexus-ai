import { db } from "@/db";
import { siteAccounts } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireAdmin, requireOwner } from "@/lib/auth";
import { accountsFor, checkedAccount, serializeAccount } from "@/lib/browser/accounts";
import { ONLY_OWNER, siteHost } from "@/lib/browser/rules";
import { getClientMeta } from "@/lib/request";
import { siteAccountCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The site accounts the projects of this account may sign in with: all of
 * them for an owner, the ones opened to administrators for an administrator.
 * Never with a password, and never with the session that is kept.
 */
export const GET = handle(async () => {
  const user = requireAdmin();
  return json({ accounts: accountsFor(user).map(serializeAccount), canManage: user.role === "owner" });
});

/** Save an account. Its password is kept encrypted and is not handed out again. */
export const POST = handle(async (req) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, siteAccountCreateSchema);
  const { values } = checkedAccount(body);
  const row = db
    .insert(siteAccounts)
    .values({ ...values, createdBy: user.id })
    .returning()
    .get();
  audit({
    actorUserId: user.id,
    action: "site_account.create",
    targetType: "site_account",
    targetId: row.id,
    metadata: { name: row.name, site: siteHost(row.siteUrl), username: row.username, access: row.access },
    ip,
    userAgent,
  });
  return json({ account: serializeAccount(row) }, { status: 201 });
});
