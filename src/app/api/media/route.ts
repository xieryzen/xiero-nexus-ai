import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { serializeAsset } from "@/lib/media/dto";
import { listAssets } from "@/lib/media/service";
import { loadOwnedProject } from "@/lib/project-access";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 60;

/**
 * The signed-in user's media, newest first.
 *   ?kind=image|video   one kind only
 *   ?projectId=…        what one project's runs produced (owner or admin)
 *   ?scope=all          everyone's media (administrators)
 *   ?offset=N           paging
 */
export const GET = handle(async (req) => {
  const user = requireUser();
  const query = new URL(req.url).searchParams;

  const kindParam = query.get("kind");
  if (kindParam && kindParam !== "image" && kindParam !== "video") {
    throw Errors.badRequest("kind must be image or video");
  }
  const kind = kindParam === "image" || kindParam === "video" ? kindParam : undefined;

  const all = query.get("scope") === "all";
  if (all && user.role !== "admin") throw Errors.forbidden();

  const projectId = query.get("projectId") ?? undefined;
  if (projectId) loadOwnedProject(projectId, user); // throws unless owner or admin

  const offset = Math.max(0, Math.floor(Number(query.get("offset")) || 0));

  // A project's media belongs to the project's owner, whoever is looking.
  const rows = listAssets({
    userId: all || projectId ? undefined : user.id,
    kind,
    projectId,
    limit: PAGE_SIZE + 1,
    offset,
  });
  const page = rows.slice(0, PAGE_SIZE);
  return json({
    assets: page.map((r) => serializeAsset(r.asset, all ? r.owner : undefined)),
    nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  });
});
