import { deleteAccountNote } from "@/lib/account-memory";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Forget one note of the account that asks. */
export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const id = Number(params.id);
  if (!Number.isInteger(id) || !deleteAccountNote(user.id, id)) throw Errors.notFound("Note not found");
  return json({ ok: true });
});
