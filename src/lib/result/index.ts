import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, projectTasks, toolCalls, workspaceFiles, workspaces, type BuiltFile, type MediaAsset, type Project } from "@/db/schema";
import { isMediaFileName } from "../media/files";
import { mediaDir } from "../media/store";
import { noteFileCall } from "../orchestrator/deliverable";
import { buildStateOf, type BuildState } from "./build";
import { builtOnDisk, listBuilt, sourceHashOf } from "./built";
import { baseName, downloadSlug, fileKind, siteOf, type FileKind, type SiteShape } from "./kinds";
import { sitePreviewOf } from "./site";
import type { ZipSource } from "./zip";
import { join } from "node:path";

/**
 * What a project made, as the things they are: the files its agents wrote,
 * the web site among them, the packages its builds left behind, and where
 * all of it is downloaded. The project page shows this above everything
 * else: a finished project is its result, not the words about it.
 */

export interface ResultFile {
  id: string;
  path: string;
  size: number;
  kind: FileKind;
  updatedAt: number;
  /** The task that wrote it last, by its number; null when no task of the last run did. */
  task: number | null;
}

export interface ResultBuilt {
  id: string;
  path: string;
  name: string;
  size: number;
  createdAt: number;
  /** It was built from the files as they are now. */
  current: boolean;
  /** Where it is downloaded. */
  url: string;
}

export interface ProjectResult {
  /** The workspace the files are in; null when the project has none yet. */
  workspaceId: string | null;
  files: ResultFile[];
  /** The files together, in characters. */
  bytes: number;
  /** The web site among the files. */
  site: SiteShape | null;
  /**
   * Where the files are shown as they are, each under its path: a page with
   * its style sheets and scripts, in a sandbox. Anyone who has this address
   * can look at these files until it ends.
   */
  preview: { base: string; expiresAt: number } | null;
  built: ResultBuilt[];
  build: BuildState | null;
  /** Where everything is downloaded as one archive, and what it is called. */
  download: { url: string; name: string };
}

/** The task that wrote each file last, by path. */
function writersOf(projectId: string): Map<string, number> {
  const tasks = db
    .select({ id: projectTasks.id, seq: projectTasks.seq, outputFile: projectTasks.outputFile, status: projectTasks.status })
    .from(projectTasks)
    .where(eq(projectTasks.projectId, projectId))
    .orderBy(asc(projectTasks.seq))
    .all();
  const writers = new Map<string, number>();
  if (tasks.length === 0) return writers;
  const calls = db
    .select({ taskId: toolCalls.taskId, name: toolCalls.name, result: toolCalls.result, isError: toolCalls.isError })
    .from(toolCalls)
    .where(and(eq(toolCalls.projectId, projectId), inArray(toolCalls.name, ["write_file", "edit_file", "delete_file"])))
    .orderBy(asc(toolCalls.createdAt), asc(toolCalls.step))
    .all();
  for (const task of tasks) {
    const written = new Set<string>();
    for (const call of calls) if (call.taskId === task.id) noteFileCall(written, call);
    // A task whose answer was saved as its output file wrote that file too.
    if (task.outputFile && task.status === "succeeded") written.add(task.outputFile);
    for (const path of written) writers.set(path, task.seq);
  }
  return writers;
}

function builtDto(projectId: string, file: BuiltFile, hash: string): ResultBuilt {
  return {
    id: file.id,
    path: file.path,
    name: baseName(file.path),
    size: file.sizeBytes,
    createdAt: file.createdAt.getTime(),
    current: file.sourceHash === hash,
    url: `/api/projects/${projectId}/built/${file.id}`,
  };
}

export function projectResult(project: Pick<Project, "id" | "title">): ProjectResult {
  const download = { url: `/api/projects/${project.id}/download`, name: `${downloadSlug(project.title)}.zip` };
  const workspace = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, project.id)).get();
  if (!workspace) {
    return { workspaceId: null, files: [], bytes: 0, site: null, preview: null, built: [], build: null, download };
  }
  const rows = db.select().from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspace.id)).orderBy(asc(workspaceFiles.path)).all();
  const writers = writersOf(project.id);
  const hash = sourceHashOf(rows);
  return {
    workspaceId: workspace.id,
    files: rows.map((f) => ({
      id: f.id,
      path: f.path,
      size: f.size,
      kind: fileKind(f.path),
      updatedAt: f.updatedAt.getTime(),
      task: writers.get(f.path) ?? null,
    })),
    bytes: rows.reduce((sum, f) => sum + f.size, 0),
    site: siteOf(rows.map((f) => f.path)),
    preview: rows.length > 0 ? sitePreviewOf(project.id) : null,
    built: listBuilt(project.id).map((b) => builtDto(project.id, b, hash)),
    build: buildStateOf(project.id, workspace.id, rows),
    download,
  };
}

// ─── The media of a project, as files ────────────────────────────────────────

/** The pictures, videos and voice-overs a project made that are ready, oldest first. */
export function readyMediaOf(projectId: string): MediaAsset[] {
  return db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.status, "ready")))
    .orderBy(asc(mediaAssets.createdAt), asc(mediaAssets.id))
    .all()
    .filter((a) => a.fileName !== null && isMediaFileName(a.fileName));
}

/**
 * The path a project's picture has among its files: "media/<file>". A page
 * an agent writes can show the picture under that path, in the preview and
 * in the archive alike.
 */
export function mediaPath(fileName: string): string {
  return `media/${fileName}`;
}

/** The largest archive that still takes the media along. Above it, the media is downloaded piece by piece. */
export const DOWNLOAD_MEDIA_MAX_BYTES = 1_500_000_000;

/** Everything a project made, as the entries of one archive: its files, what was built from them, and its media. */
export function downloadSources(projectId: string): { sources: ZipSource[]; mediaLeftOut: number } {
  const sources: ZipSource[] = [];
  const workspace = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, projectId)).get();
  if (workspace) {
    for (const file of db.select().from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspace.id)).orderBy(asc(workspaceFiles.path)).all()) {
      sources.push({ path: file.path, data: Buffer.from(file.content, "utf8"), modified: file.updatedAt });
    }
  }
  for (const built of listBuilt(projectId)) {
    const onDisk = builtOnDisk(built);
    if (onDisk) sources.push({ path: built.path, file: onDisk.path, size: onDisk.size, modified: built.createdAt });
  }
  const media = readyMediaOf(projectId);
  let bytes = 0;
  let leftOut = 0;
  for (const asset of media) {
    const size = asset.sizeBytes ?? 0;
    if (bytes + size > DOWNLOAD_MEDIA_MAX_BYTES) {
      leftOut++;
      continue;
    }
    bytes += size;
    sources.push({ path: mediaPath(asset.fileName!), file: join(mediaDir(), asset.fileName!), size, modified: asset.completedAt ?? asset.createdAt });
  }
  return { sources, mediaLeftOut: leftOut };
}
