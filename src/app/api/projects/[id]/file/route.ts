import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceFiles, workspaces } from "@/db/schema";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { loadOwnedProject } from "@/lib/project-access";
import { baseName } from "@/lib/result/kinds";

export const dynamic = "force-dynamic";

/**
 * One file of the project, as a download:  ?path=src/Main.java
 * Always a download and never a page: a file an agent wrote is not shown as
 * a page of the app (the preview at /site does that, in a sandbox).
 */
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const workspace = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, project.id)).get();
  const file = workspace
    ? db.select().from(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, workspace.id), eq(workspaceFiles.path, path))).get()
    : undefined;
  if (!file) throw Errors.notFound("File not found");
  const name = baseName(file.path).replace(/[^A-Za-z0-9._+-]/g, "_") || "file.txt";
  return new Response(file.content, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
