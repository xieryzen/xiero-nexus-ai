import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workflows } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { serializeWorkflow } from "@/lib/workforce";
import { workflowUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const PATCH = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = db.select().from(workflows).where(eq(workflows.id, params.id!)).get();
  if (!existing) throw Errors.notFound("Workflow not found");
  const body = await parseBody(req, workflowUpdateSchema);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description ?? null;
  if (body.steps !== undefined) patch.steps = JSON.stringify(body.steps);

  db.update(workflows).set(patch).where(eq(workflows.id, existing.id)).run();
  audit({ actorUserId: user.id, action: "workflow.update", targetType: "workflow", targetId: existing.id, ip, userAgent });
  const fresh = db.select().from(workflows).where(eq(workflows.id, existing.id)).get()!;
  return json({ workflow: serializeWorkflow(fresh) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = db.select().from(workflows).where(eq(workflows.id, params.id!)).get();
  if (!existing) throw Errors.notFound("Workflow not found");
  db.delete(workflows).where(eq(workflows.id, existing.id)).run();
  audit({ actorUserId: user.id, action: "workflow.delete", targetType: "workflow", targetId: existing.id, metadata: { name: existing.name }, ip, userAgent });
  return json({ ok: true });
});
