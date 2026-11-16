import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createAccount, createAccountSchema } from "@/lib/accounts";
import { handle, json, parseBody } from "@/lib/api";
import { publicUser, requireAdmin, requireOwner } from "@/lib/auth";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

/** The accounts. Administrators see them; an owner changes them. */
export const GET = handle(async () => {
  requireAdmin();
  const rows = db.select().from(users).orderBy(desc(users.createdAt)).all();
  return json({ users: rows.map(publicUser) });
});

/** An owner makes an account, with the role and the first password it is to have. */
export const POST = handle(async (req) => {
  const owner = requireOwner();
  const body = await parseBody(req, createAccountSchema);
  const created = createAccount(owner, body, getClientMeta(req));
  return json({ user: publicUser(created) }, { status: 201 });
});
