import { deleteAccount, updateAccount, updateAccountSchema } from "@/lib/accounts";
import { handle, json, parseBody } from "@/lib/api";
import { publicUser, requireOwner } from "@/lib/auth";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * An owner changes an account: its username, email, password, role or
 * status, switches a lost second factor off, or signs it out everywhere.
 */
export const PATCH = handle(async (req, { params }) => {
  const owner = requireOwner();
  const body = await parseBody(req, updateAccountSchema);
  const updated = updateAccount(owner, params.id!, body, getClientMeta(req));
  return json({ user: publicUser(updated) });
});

/** An owner deletes an account. What it made stays, without an owner. */
export const DELETE = handle(async (req, { params }) => {
  const owner = requireOwner();
  deleteAccount(owner, params.id!, getClientMeta(req));
  return json({ ok: true });
});
