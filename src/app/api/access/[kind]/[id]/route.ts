import { changeAccess, type AccessDTO } from "@/lib/access/store";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { accessChangeSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function kindOf(value: string | undefined): AccessDTO["kind"] {
  if (value === "server" || value === "site" || value === "key") return value;
  throw Errors.notFound("Not found");
}

/**
 * Something the account that asks handed to the AI in a conversation: switch
 * it off or on, or tie a key to the site it is for. Only its own: the answer
 * is the same for what is not there and for what is someone else's.
 */
export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const kind = kindOf(params.kind);
  const body = await parseBody(req, accessChangeSchema);
  if (body.status === undefined && body.site === undefined) throw Errors.badRequest("Nothing to change");
  if (!changeAccess(user, kind, params.id!, { status: body.status, site: body.site }, getClientMeta(req))) throw Errors.notFound("Not found");
  return json({ ok: true });
});

/** Remove it: what signs in is deleted, and no chat or run reaches it any more. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const kind = kindOf(params.kind);
  if (!changeAccess(user, kind, params.id!, { remove: true }, getClientMeta(req))) throw Errors.notFound("Not found");
  return json({ ok: true });
});
