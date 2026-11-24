import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadOperableProject } from "@/lib/project-access";
import { getClientMeta } from "@/lib/request";
import { projectResult } from "@/lib/result";
import { buildProject } from "@/lib/result/build";
import { ensureWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/**
 * Build the project: the command its build file calls for (Gradle, Maven),
 * in the sandbox runner. The packages the build leaves behind are kept as
 * the project's built files. Answers when the build has ended, which can
 * take minutes; the build goes on when the page that asked is closed.
 *   400 nothing_to_build / execution_disabled, 409 build_active.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOperableProject(params.id!, user);
  const workspace = ensureWorkspace(project.id, project.createdBy);
  const outcome = await buildProject({ projectId: project.id, workspaceId: workspace.id, userId: user.id });
  audit({
    actorUserId: user.id,
    action: "project.build",
    targetType: "project",
    targetId: project.id,
    metadata: { command: outcome.plan.command, exitCode: outcome.exitCode, kept: outcome.kept.map((k) => k.path) },
    ip,
    userAgent,
  });
  return json({
    build: {
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      log: outcome.log,
      kept: outcome.kept.map((k) => ({ id: k.id, path: k.path, size: k.sizeBytes })),
      notKept: outcome.refused,
    },
    result: projectResult(project),
  });
});
