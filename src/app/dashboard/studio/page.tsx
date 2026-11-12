import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { serializeAsset } from "@/lib/media/dto";
import { listAssets } from "@/lib/media/service";
import { mediaModelOptions, usableModels } from "@/lib/model-options";
import { StudioClient } from "@/components/studio/studio-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Creative Studio" };

const PAGE_SIZE = 60;

export default function StudioPage({
  searchParams,
}: {
  searchParams: { project?: string | string[] };
}) {
  const user = requirePageUser();

  // ?project=<id>: what one project's runs produced, for its owner or an admin.
  const projectId = typeof searchParams.project === "string" ? searchParams.project : null;
  const projectRow = projectId
    ? db.select().from(projects).where(eq(projects.id, projectId)).get()
    : undefined;
  const project =
    projectRow && (projectRow.createdBy === user.id || user.role === "admin")
      ? { id: projectRow.id, title: projectRow.title }
      : null;

  const rows = listAssets({
    userId: project ? undefined : user.id,
    projectId: project?.id,
    limit: PAGE_SIZE + 1,
  });

  const all = usableModels();
  return (
    <StudioClient
      imageModels={mediaModelOptions("image", all)}
      videoModels={mediaModelOptions("video", all)}
      initialAssets={rows.slice(0, PAGE_SIZE).map((r) => serializeAsset(r.asset))}
      initialNextOffset={rows.length > PAGE_SIZE ? PAGE_SIZE : null}
      isAdmin={user.role === "admin"}
      project={project}
    />
  );
}
