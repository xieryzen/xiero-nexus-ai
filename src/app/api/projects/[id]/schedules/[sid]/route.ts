import { takeAccessForProject } from "@/lib/access/store";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadOperableProject, loadOwnedProject } from "@/lib/project-access";
import { getClientMeta } from "@/lib/request";
import { deleteSchedule, loadSchedule, serializeSchedule, updateSchedule } from "@/lib/schedules";
import { scheduleUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOperableProject(params.id!, user);
  const schedule = loadSchedule(project.id, params.sid!);
  const body = await parseBody(req, scheduleUpdateSchema);
  // What signs in is taken out of the instruction before it is stored (src/lib/access).
  const taken = body.input ? await takeAccessForProject(user, project, body.input, { ip, userAgent }) : null;
  if (taken) body.input = taken.text;
  const updated = updateSchedule(schedule, body);
  audit({
    actorUserId: user.id,
    action: "schedule.update",
    targetType: "project",
    targetId: project.id,
    metadata: { cron: updated.cron, timezone: updated.timezone, enabled: updated.enabled },
    ip,
    userAgent,
  });
  return json({ schedule: serializeSchedule(updated), kept: taken?.kept ?? [] });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOwnedProject(params.id!, user);
  const schedule = loadSchedule(project.id, params.sid!);
  deleteSchedule(schedule);
  audit({
    actorUserId: user.id,
    action: "schedule.delete",
    targetType: "project",
    targetId: project.id,
    metadata: { cron: schedule.cron },
    ip,
    userAgent,
  });
  return json({ ok: true });
});
