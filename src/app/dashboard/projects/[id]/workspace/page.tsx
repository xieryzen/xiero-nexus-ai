import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { ensureWorkspace, listFiles } from "@/lib/workspace";
import { getExecutor } from "@/lib/workspace/executor";
import { getRemote, serializeRemote } from "@/lib/git";
import { PageHeader } from "@/components/ui";
import { WorkspaceClient } from "@/components/workspace/workspace-client";
import { GitPanel } from "@/components/workspace/git-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workspace" };

export default function WorkspacePage({ params }: { params: { id: string } }) {
  const user = requirePageUser();
  const project = db.select().from(projects).where(eq(projects.id, params.id)).get();
  if (!project) notFound();
  if (project.createdBy !== user.id && user.role !== "admin") redirect("/dashboard/projects");

  const ws = ensureWorkspace(project.id, user.id);
  const executor = getExecutor();
  const remote = getRemote(project.id);

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title={`${project.title} · Workspace`} description="Files produced by the workforce, sandboxed execution, and Git." />
        <div className="-mt-3">
          <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-ink-3 hover:text-ink">
            ← Back to project
          </Link>
        </div>
      </div>
      <WorkspaceClient
        workspaceId={ws.id}
        initialFiles={listFiles(ws.id)}
        execution={{ enabled: executor.enabled, allowedCommands: executor.allowedCommands }}
      />
      <GitPanel projectId={project.id} initial={remote ? serializeRemote(remote) : null} />
    </div>
  );
}
