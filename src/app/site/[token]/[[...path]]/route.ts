import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, projects, workspaceFiles, workspaces } from "@/db/schema";
import { isMediaFileName } from "@/lib/media/files";
import { mediaFileResponse } from "@/lib/media/serve";
import { siteContentType, siteOf } from "@/lib/result/kinds";
import { projectOfSiteToken } from "@/lib/result/site";

export const dynamic = "force-dynamic";

/**
 * The files of a project, shown as the web site they are:
 *
 *   /site/<token>/index.html, /site/<token>/css/style.css, /site/<token>/media/<file>
 *
 * What an agent wrote is not trusted, so nothing here is a page of the app.
 * Every answer is sandboxed: the page has no origin, cannot read the app's
 * cookies or storage, and the browser sends none of the app's cookies with
 * what the page asks for. That is also why nobody is signed in here: the
 * token in the address is the permission, for this one project, until it
 * ends (src/lib/result/site-token.ts). The page may run its scripts and load
 * what it names from the web, as it would on any host; it cannot leave its
 * frame.
 */

const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; frame-ancestors 'self'";

function headers(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": SANDBOX,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    // The page has no origin, so what it fetches for itself is asked across
    // origins: a script module, a font, a JSON file of its own.
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    "x-robots-tag": "noindex, nofollow",
  };
}

function plain(status: number, text: string): Response {
  return new Response(`${text}\n`, { status, headers: headers("text/plain; charset=utf-8") });
}

/** A segment of an address, written so that it is one again. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function GET(req: Request, { params }: { params: { token: string; path?: string[] } }): Promise<Response> {
  const projectId = projectOfSiteToken(params.token);
  if (!projectId) return plain(410, "This address has ended, or is not one of this server. Open the project again for a new one.");
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  const workspace = project ? db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, projectId)).get() : undefined;
  if (!project || !workspace) return plain(404, "This project has no files.");

  const base = `/site/${params.token}/`;
  const segments = params.path ?? [];
  // Nothing may lead out of the folder, however it is written.
  if (segments.some((part) => part === ".." || part === "." || part.includes("\\") || part.includes("\u0000"))) return plain(404, "Not found.");
  const path = segments.join("/");

  const fileAt = (at: string) =>
    db.select().from(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, workspace.id), eq(workspaceFiles.path, at))).get();
  const redirect = (to: string) => new Response(null, { status: 307, headers: { ...headers("text/plain; charset=utf-8"), location: `${base}${encodePath(to)}` } });

  if (path === "") {
    // The site's first page. Its address ends in the page's name, so that what the page names beside itself is found.
    const paths = db.select({ path: workspaceFiles.path }).from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspace.id)).all();
    const site = siteOf(paths.map((p) => p.path));
    return site ? redirect(site.entry) : plain(404, "This project has no web page.");
  }

  // The pictures, videos and voice-overs the project made: media/<file>.
  if (segments.length === 2 && segments[0] === "media" && isMediaFileName(segments[1]!)) {
    const asset = db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.fileName, segments[1]!), eq(mediaAssets.status, "ready")))
      .get();
    if (asset) {
      try {
        const res = await mediaFileResponse(asset, req);
        const merged = new Headers(res.headers);
        for (const [key, value] of Object.entries(headers(res.headers.get("content-type") ?? "application/octet-stream"))) merged.set(key, value);
        return new Response(res.body, { status: res.status, headers: merged });
      } catch {
        return plain(404, "Not found.");
      }
    }
  }

  const file = fileAt(path);
  if (file) return new Response(file.content, { status: 200, headers: headers(siteContentType(file.path)) });
  // A folder, asked for by its name: its first page, under the page's own address.
  for (const index of [`${path}/index.html`, `${path}/index.htm`]) {
    if (fileAt(index)) return redirect(index);
  }
  // A page asked for without its ending, as links between pages often are.
  if (!/\.[A-Za-z0-9]+$/.test(path) && fileAt(`${path}.html`)) return redirect(`${path}.html`);
  return plain(404, `Not found: this project has no file ${path}`);
}
