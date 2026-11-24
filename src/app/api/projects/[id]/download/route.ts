import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { loadOwnedProject } from "@/lib/project-access";
import { downloadSources } from "@/lib/result";
import { downloadSlug } from "@/lib/result/kinds";
import { zipFits, zipStream } from "@/lib/result/zip";

export const dynamic = "force-dynamic";

/**
 * Everything the project made as one archive: its files under their paths,
 * the packages built from them, and its pictures, videos and voice-overs
 * under media/.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const { sources } = downloadSources(project.id);
  if (sources.length === 0) throw Errors.notFound("This project has made nothing to download yet");
  if (!zipFits(sources)) throw Errors.badRequest("What this project made is too much for one archive. Download its files one by one.");
  return new Response(zipStream(sources), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${downloadSlug(project.title)}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
