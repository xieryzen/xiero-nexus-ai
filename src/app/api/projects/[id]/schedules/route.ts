import { takeAccessForProject } from "@/lib/access/store";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadOperableProject, loadOwnedProject } from "@/lib/project-access";
import { getClientMeta } from "@/lib/request";
import { createSchedule, listSchedules, serializeSchedule } from "@/lib/schedules";
import { scheduleCreateSchema } from "@/lib/validation";
import { assertFeatureFor } from "@/lib/plans";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  return json({ schedules: listSchedules(project.id).map(serializeSchedule) });
});

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOperableProject(params.id!, user);
  // A schedule runs the project for the account it belongs to: a feature of that account's plan.
  assertFeatureFor(project.createdBy, "automation");
  const body = await parseBody(req, scheduleCreateSchema);
  // What signs in is taken out of the instruction before it is stored (src/lib/access).
  const taken = body.input ? await takeAccessForProject(user, project, body.input, { ip, userAgent }) : null;
  if (taken) body.input = taken.text;
  const schedule = createSchedule(project, user.id, body);
  audit({
    actorUserId: user.id,
    action: "schedule.create",
    targetType: "project",
    targetId: project.id,
    metadata: { cron: schedule.cron, timezone: schedule.timezone },
    ip,
    userAgent,
  });
  return json({ schedule: serializeSchedule(schedule), kept: taken?.kept ?? [] }, { status: 201 });
});
