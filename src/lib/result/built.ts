import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { builtFiles, type BuiltFile } from "@/db/schema";
import { env } from "../env";
import { Errors } from "../errors";
import { validateWorkspacePath } from "../workspace/paths";
import { baseName, dirName, extensionOf, isPackage } from "./kinds";

/**
 * What builds made, on disk. The files of a workspace are text in the
 * database; a package is not, so its bytes are kept in one flat folder, each
 * under a name this module made ("<id>.bin"), and a row says which project
 * and which path it belongs to. A name from outside never becomes a path on
 * disk here.
 */

/** Most a project keeps: so many packages, and so many bytes together. */
export const BUILT_MAX_FILES = 40;
export const BUILT_MAX_PROJECT_BYTES = 256 * 1024 * 1024;

const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;

export function builtDir(): string {
  return resolve(env.builtPath);
}

function pathOnDisk(fileName: string): string {
  if (!FILE_NAME.test(fileName)) throw Errors.notFound("This file is not available");
  return join(builtDir(), fileName);
}

/**
 * The files of a workspace as one hash: a package is of the files as they
 * were when it was built, and this says whether they are still the same.
 */
export function sourceHashOf(files: readonly { path: string; content: string }[]): string {
  const hash = createHash("sha256");
  for (const file of files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export function listBuilt(projectId: string): BuiltFile[] {
  return db.select().from(builtFiles).where(eq(builtFiles.projectId, projectId)).orderBy(asc(builtFiles.path)).all();
}

export function getBuilt(projectId: string, id: string): BuiltFile {
  const file = db.select().from(builtFiles).where(and(eq(builtFiles.id, id), eq(builtFiles.projectId, projectId))).get();
  if (!file) throw Errors.notFound("This file is not available");
  return file;
}

function removeFromDisk(fileName: string): void {
  try {
    rmSync(pathOnDisk(fileName), { force: true });
  } catch {
    // A file that cannot be removed is left: its row is gone, and nothing leads to it.
  }
}

export function deleteBuilt(projectId: string, id: string): void {
  const file = getBuilt(projectId, id);
  db.delete(builtFiles).where(eq(builtFiles.id, file.id)).run();
  removeFromDisk(file.fileName);
}

/** Everything a project's builds made is removed: for a project that is deleted. */
export function removeBuiltOf(projectId: string): void {
  const files = listBuilt(projectId);
  db.delete(builtFiles).where(eq(builtFiles.projectId, projectId)).run();
  for (const file of files) removeFromDisk(file.fileName);
}

export interface StoreInput {
  projectId: string;
  files: { path: string; data: Buffer }[];
  command: string;
  sourceHash: string;
  taskId?: string | null;
  userId?: string | null;
}

export interface StoreResult {
  kept: BuiltFile[];
  refused: { path: string; reason: string }[];
}

/**
 * Keep the packages a build left behind. A build makes its output folder
 * anew, so the packages a project had in the same folders make way: a plugin
 * that is now version 1.1 does not sit next to its 1.0. Packages elsewhere
 * stay.
 */
export function storeBuilt(input: StoreInput): StoreResult {
  const refused: { path: string; reason: string }[] = [];
  const fresh: { path: string; data: Buffer }[] = [];
  for (const file of input.files) {
    let path: string;
    try {
      path = validateWorkspacePath(file.path);
    } catch {
      refused.push({ path: file.path.slice(0, 256), reason: "not a path of the workspace" });
      continue;
    }
    if (!isPackage(path)) continue;
    if (file.data.length === 0) {
      refused.push({ path, reason: "empty" });
      continue;
    }
    if (!fresh.some((f) => f.path === path)) fresh.push({ path, data: file.data });
  }
  if (fresh.length === 0) return { kept: [], refused };

  const folders = new Set(fresh.map((f) => dirName(f.path)));
  const before = listBuilt(input.projectId);
  const replaced = before.filter((b) => folders.has(dirName(b.path)));
  const staying = before.filter((b) => !folders.has(dirName(b.path)));
  let bytes = staying.reduce((sum, b) => sum + b.sizeBytes, 0);
  let count = staying.length;

  mkdirSync(builtDir(), { recursive: true, mode: 0o700 });
  const written: { path: string; data: Buffer; id: string; fileName: string; sha256: string }[] = [];
  for (const file of fresh) {
    if (count >= BUILT_MAX_FILES) {
      refused.push({ path: file.path, reason: `the project keeps at most ${BUILT_MAX_FILES} built files` });
      continue;
    }
    if (bytes + file.data.length > BUILT_MAX_PROJECT_BYTES) {
      refused.push({ path: file.path, reason: `the built files of the project would be more than ${Math.round(BUILT_MAX_PROJECT_BYTES / (1024 * 1024))} MB together` });
      continue;
    }
    const id = randomUUID();
    const fileName = `${id}.bin`;
    const target = pathOnDisk(fileName);
    const partial = `${target}.part`;
    writeFileSync(partial, file.data, { mode: 0o600 });
    renameSync(partial, target);
    written.push({ ...file, id, fileName, sha256: createHash("sha256").update(file.data).digest("hex") });
    bytes += file.data.length;
    count++;
  }
  if (written.length === 0) return { kept: [], refused };

  const kept = db.transaction((tx) => {
    for (const old of replaced) tx.delete(builtFiles).where(eq(builtFiles.id, old.id)).run();
    return written.map((file) =>
      tx
        .insert(builtFiles)
        .values({
          id: file.id,
          projectId: input.projectId,
          path: file.path,
          fileName: file.fileName,
          sizeBytes: file.data.length,
          sha256: file.sha256,
          command: input.command.slice(0, 2000),
          sourceHash: input.sourceHash,
          taskId: input.taskId ?? null,
          createdBy: input.userId ?? null,
        })
        .returning()
        .get(),
    );
  });
  for (const old of replaced) removeFromDisk(old.fileName);
  return { kept, refused };
}

function contentTypeOf(path: string): string {
  switch (extensionOf(path)) {
    case "jar":
      return "application/java-archive";
    case "zip":
    case "mcaddon":
    case "mcpack":
    case "mcworld":
      return "application/zip";
    case "tgz":
      return "application/gzip";
    default:
      return "application/octet-stream";
  }
}

/** Where a built file is on disk, and how large it is there; null when it is gone. */
export function builtOnDisk(file: BuiltFile): { path: string; size: number } | null {
  try {
    const path = pathOnDisk(file.fileName);
    return { path, size: statSync(path).size };
  } catch {
    return null;
  }
}

/**
 * A built file as a download. Never shown in the page: whatever a build
 * made, a browser saves it and does not open it.
 */
export function builtFileResponse(file: BuiltFile): Response {
  const onDisk = builtOnDisk(file);
  if (!onDisk) throw Errors.notFound("The file is missing from the folder for built files");
  const name = baseName(file.path).replace(/[^A-Za-z0-9._+-]/g, "_") || "file.bin";
  return new Response(onDisk.size === 0 ? null : (Readable.toWeb(createReadStream(onDisk.path)) as unknown as ReadableStream<Uint8Array>), {
    status: 200,
    headers: {
      "content-type": contentTypeOf(file.path),
      "content-disposition": `attachment; filename="${name}"`,
      "content-length": String(onDisk.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
