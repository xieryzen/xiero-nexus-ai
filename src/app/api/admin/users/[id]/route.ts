import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { publicUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { destroyAllSessions } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    role: z.enum(["admin", "user"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "Nothing to update",
  });

export const PATCH = handle(async (req, { params }) => {
  const admin = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);

  if (params.id === admin.id) {
    throw Errors.badRequest("You cannot change your own role or status here");
  }
  const target = db.select().from(users).where(eq(users.id, params.id!)).get();
  if (!target) throw Errors.notFound("User not found");

  const body = await parseBody(req, schema);

  // Never allow removing the last remaining admin.
  if ((body.role === "user" || body.status === "disabled") && target.role === "admin") {
    const otherAdmins =
      db
        .select({ v: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, target.id)))
        .get()?.v ?? 0;
    if (otherAdmins === 0) {
      throw Errors.badRequest("At least one active admin must remain");
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.role !== undefined) patch.role = body.role;
  if (body.status !== undefined) patch.status = body.status;
  db.update(users).set(patch).where(eq(users.id, target.id)).run();

  // Disabling a user should immediately end their sessions.
  if (body.status === "disabled") destroyAllSessions(target.id);

  audit({
    actorUserId: admin.id,
    action: "admin.user.update",
    targetType: "user",
    targetId: target.id,
    metadata: { role: body.role, status: body.status },
    ip,
    userAgent,
  });

  const fresh = db.select().from(users).where(eq(users.id, target.id)).get()!;
  return json({ user: publicUser(fresh) });
});
