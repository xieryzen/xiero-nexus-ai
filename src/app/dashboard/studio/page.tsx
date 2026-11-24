import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { serializeAsset } from "@/lib/media/dto";
import { ffmpegStatus } from "@/lib/media/ffmpeg";
import { listAssets } from "@/lib/media/service";
import { assetFor } from "@/lib/for-viewer";
import { appChoice } from "@/lib/model-choice";
import { mediaModelOptions, usableModels, type MediaModelOption } from "@/lib/model-options";
import { StudioClient } from "@/components/studio/studio-client";
import { hasFeature, notInPlan } from "@/lib/plan-rules";
import { getPlanSettings } from "@/lib/plans";
import { isAdminRole, tierOf } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Creative Studio" };

const PAGE_SIZE = 60;

export default async function StudioPage({
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
    projectRow && (projectRow.createdBy === user.id || isAdminRole(user.role))
      ? { id: projectRow.id, title: projectRow.title }
      : null;

  const rows = listAssets({
    userId: project ? undefined : user.id,
    projectId: project?.id,
    limit: PAGE_SIZE + 1,
  });

  const all = usableModels();
  const ffmpeg = await ffmpegStatus();
  // Someone who is shown the setup chooses among the models. A user is handed
  // one entry per kind the installation can do, without a name and a price:
  // only the options that kind of request takes. The app chooses the model.
  const sees = isAdminRole(user.role);
  const tier = tierOf(user);
  // What the plan of the account does not have is said in the place of its form.
  const settings = getPlanSettings();
  const FEATURE_OF = { image: "studio_image", video: "studio_video", audio: "studio_voice" } as const;
  const notInPlanText: Partial<Record<"image" | "video" | "audio", string>> = {};
  for (const kind of ["image", "video", "audio"] as const) {
    if (!hasFeature(settings, tier, FEATURE_OF[kind])) notInPlanText[kind] = notInPlan(settings, tier, FEATURE_OF[kind]);
  }
  const options = (kind: "image" | "video" | "audio"): MediaModelOption[] => {
    const list = mediaModelOptions(kind, all);
    if (sees) return list;
    const choice = appChoice(kind, tier);
    const chosen = list.find((m) => m.id === choice) ?? (choice ? list[0] : undefined);
    return chosen ? [{ id: "auto", label: "", mediaApi: chosen.mediaApi, price: null }] : [];
  };
  return (
    <StudioClient
      imageModels={options("image")}
      videoModels={options("video")}
      speechModels={options("audio")}
      render={{ available: ffmpeg.available && ffmpeg.h264, subtitles: ffmpeg.available && ffmpeg.subtitles }}
      initialAssets={rows.slice(0, PAGE_SIZE).map((r) => assetFor(user.role, serializeAsset(r.asset)))}
      initialNextOffset={rows.length > PAGE_SIZE ? PAGE_SIZE : null}
      isAdmin={isAdminRole(user.role)}
      project={project}
      notInPlan={notInPlanText}
    />
  );
}
