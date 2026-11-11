import { asc } from "drizzle-orm";
import { db } from "@/db";
import { workflows } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { serializeWorkflow } from "@/lib/workforce";
import { workflowCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  requireUser();
  const rows = db.select().from(workflows).orderBy(asc(workflows.name)).all();
  return json({ workflows: rows.map(serializeWorkflow) });
});

export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, workflowCreateSchema);
  const wf = db
    .insert(workflows)
    .values({
      name: body.name,
      description: body.description ?? null,
      steps: JSON.stringify(body.steps ?? []),
      createdBy: user.id,
    })
    .returning()
    .get();
  audit({ actorUserId: user.id, action: "workflow.create", targetType: "workflow", targetId: wf.id, metadata: { name: wf.name, steps: (body.steps ?? []).length }, ip, userAgent });
  return json({ workflow: serializeWorkflow(wf) }, { status: 201 });
});
