import { deleteMemory } from "@/lib/agent/memory";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Delete one note: a user one of their own, an administrator any. */
export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const id = Number(params.mid);
  if (!Number.isInteger(id) || id <= 0) throw Errors.notFound("Note not found");
  const removed = deleteMemory(params.id!, id, user.role === "admin" ? undefined : user.id);
  if (!removed) throw Errors.notFound("Note not found");
  return json({ ok: true });
});
