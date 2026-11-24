/**
 * What a project made, by the look of its files: what kind of thing each file
 * is, whether the files are a web site and where it starts, whether they are
 * something that is built into a package, and which of the files a build
 * leaves behind are that package. Pure, so that it can be tested alone and
 * used by the pages as well as by the server.
 */

export type FileKind = "page" | "style" | "script" | "document" | "data" | "image" | "code" | "text";

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  html: "page",
  htm: "page",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  js: "script",
  mjs: "script",
  cjs: "script",
  md: "document",
  markdown: "document",
  mdx: "document",
  txt: "document",
  rst: "document",
  json: "data",
  json5: "data",
  yml: "data",
  yaml: "data",
  toml: "data",
  xml: "data",
  csv: "data",
  tsv: "data",
  ini: "data",
  properties: "data",
  env: "data",
  lang: "data",
  mcmeta: "data",
  webmanifest: "data",
  svg: "image",
  java: "code",
  kt: "code",
  kts: "code",
  gradle: "code",
  groovy: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  vue: "code",
  svelte: "code",
  py: "code",
  go: "code",
  rs: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  rb: "code",
  lua: "code",
  sh: "code",
  bash: "code",
  ps1: "code",
  bat: "code",
  sql: "code",
  mcfunction: "code",
  dockerfile: "code",
};

/** What a kind is called where a person reads it. */
export const KIND_LABEL: Record<FileKind, string> = {
  page: "web page",
  style: "style sheet",
  script: "script",
  document: "document",
  data: "data",
  image: "picture",
  code: "code",
  text: "text",
};

/** The last part of a path. */
export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The folder a path is in, without a slash at the end; "" for the top. */
export function dirName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** The extension of a path in lower case, without the dot; "" when it has none. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot > 0) return name.slice(dot + 1).toLowerCase();
  // Files that are known by their whole name.
  const whole = name.toLowerCase();
  return whole === "dockerfile" || whole === "makefile" ? whole : "";
}

export function fileKind(path: string): FileKind {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? "text";
}

/** Whether a file is written in Markdown: it is shown as a document, not as its source. */
export function isMarkdown(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

// ─── A web site ──────────────────────────────────────────────────────────────

export interface SiteShape {
  /** The page the site starts at. */
  entry: string;
  /** Every page of it, the entry first. */
  pages: string[];
}

function depth(path: string): number {
  return path.split("/").length;
}

/**
 * The web site among these files, if they hold one: its pages, and the one
 * it starts at. That is `index.html` at the top, else the `index.html`
 * nearest the top, else the page nearest the top.
 */
export function siteOf(paths: readonly string[]): SiteShape | null {
  const pages = paths.filter((p) => fileKind(p) === "page");
  if (pages.length === 0) return null;
  const byDepth = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b);
  const indexes = pages.filter((p) => /^index\.html?$/i.test(baseName(p))).sort(byDepth);
  const entry = indexes[0] ?? pages.slice().sort(byDepth)[0]!;
  return { entry, pages: [entry, ...pages.filter((p) => p !== entry).sort(byDepth)] };
}

/**
 * The type a file of a site is served as. Only text a browser shows or runs
 * inside the page's own sandbox; anything else is offered as a download.
 */
export function siteContentType(path: string): string {
  switch (extensionOf(path)) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
    case "cjs":
      return "text/javascript; charset=utf-8";
    case "json":
    case "map":
      return "application/json; charset=utf-8";
    case "webmanifest":
      return "application/manifest+json; charset=utf-8";
    case "svg":
      return "image/svg+xml; charset=utf-8";
    case "xml":
      return "application/xml; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

// ─── Something that is built ─────────────────────────────────────────────────

export type BuildTool = "gradle" | "maven";

export interface BuildPlan {
  tool: BuildTool;
  /** What the tool is called where a person reads it. */
  label: string;
  /** The file that says how it is built. */
  file: string;
  /** The command that builds it, for the runner: one program, no shell. */
  command: string;
  /** Where the packages it makes are found: patterns of paths. */
  outputs: string[];
}

const GRADLE_FILES = new Set(["build.gradle.kts", "build.gradle"]);

/** A folder a command line can name: nothing that would be split or read as an option. */
function plainFolder(dir: string): boolean {
  return dir === "" || /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(dir);
}

/**
 * How these files are built into a package, when they say so: a Gradle build
 * file or a Maven `pom.xml`. The one nearest the top is taken, Gradle before
 * Maven where both are there. The tests of the project are not run: what is
 * asked for is the package.
 */
export function buildOf(paths: readonly string[]): BuildPlan | null {
  const candidates = paths
    .filter((p) => GRADLE_FILES.has(baseName(p)) || baseName(p) === "pom.xml")
    .filter((p) => plainFolder(dirName(p)))
    // A build file inside what a build makes, or inside a dependency, is not the project's.
    .filter((p) => !/(^|\/)(node_modules|target|build|out|dist)\//.test(p))
    .sort((a, b) => depth(a) - depth(b) || (baseName(a) === "pom.xml" ? 1 : 0) - (baseName(b) === "pom.xml" ? 1 : 0) || a.localeCompare(b));
  const file = candidates[0];
  if (!file) return null;
  const dir = dirName(file);
  const under = dir ? `${dir}/` : "";
  if (baseName(file) === "pom.xml") {
    return {
      tool: "maven",
      label: "Maven",
      file,
      command: `mvn -B -ntp -q -DskipTests${dir ? ` -f ${file}` : ""} package`,
      outputs: [`${under}target/*.jar`, `${under}*/target/*.jar`],
    };
  }
  return {
    tool: "gradle",
    label: "Gradle",
    file,
    command: `gradle${dir ? ` -p ${dir}` : ""} build -x test --console=plain -q`,
    outputs: [`${under}build/libs/*.jar`, `${under}*/build/libs/*.jar`],
  };
}

/**
 * The packages a program may leave behind that are kept without being asked
 * for: what a build of Java, of a Minecraft add-on or of an archive makes.
 */
export const KEEP_DEFAULT: readonly string[] = [
  "build/libs/*.jar",
  "*/build/libs/*.jar",
  "target/*.jar",
  "*/target/*.jar",
  "build/distributions/*.zip",
  "dist/*.zip",
  "dist/*.tgz",
  "dist/*.jar",
  "*.mcaddon",
  "*.mcpack",
  "*.mcworld",
];

/** Most patterns one request names, and the longest of them. */
export const KEEP_MAX_PATTERNS = 24;
export const KEEP_MAX_PATTERN_CHARS = 200;

/**
 * Whether a path fits a pattern. `*` stands for any characters within one
 * folder, `**` for any folders, `?` for one character. Everything else is
 * itself: a pattern is never read as a regular expression.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" also stands for no folder at all.
        if (pattern[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`).test(path);
}

/**
 * Whether a file a build left behind is a package to keep, and not what a
 * build makes besides it: the sources, the documentation, or the package as
 * it was before its libraries were put into it.
 */
export function isPackage(path: string): boolean {
  const name = baseName(path);
  return !/-(sources|javadoc|tests|test-fixtures)\.jar$/i.test(name) && !/^original-.+\.jar$/i.test(name);
}

/** A pattern a request may name: a relative path with wildcards, that stays inside the folder. */
export function safePattern(raw: string): string | null {
  const pattern = raw.trim();
  if (!pattern || pattern.length > KEEP_MAX_PATTERN_CHARS) return null;
  if (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  if (!/^[A-Za-z0-9._\-/*? ]+$/.test(pattern)) return null;
  return pattern;
}

/** The patterns a run keeps: the ones it names, as far as they may be named, and the ones that are always kept. */
export function keepPatterns(named: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const raw of [...named, ...KEEP_DEFAULT]) {
    const pattern = safePattern(raw);
    if (pattern && !out.includes(pattern)) out.push(pattern);
    if (out.length >= KEEP_MAX_PATTERNS) break;
  }
  return out;
}

// ─── A list of files, by folder ──────────────────────────────────────────────

export interface FolderGroup<T> {
  /** The folder, "" for the top. */
  folder: string;
  files: T[];
}

/** Files by the folder they are in: the top first, then the folders by name. */
export function byFolder<T extends { path: string }>(files: readonly T[]): FolderGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const folder = dirName(file.path);
    const list = groups.get(folder) ?? [];
    list.push(file);
    groups.set(folder, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, files: list.slice().sort((a, b) => a.path.localeCompare(b.path)) }));
}

/** A size as a person reads it. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** A name for a download, from a title: letters, numbers and dashes. */
export function downloadSlug(title: string, fallback = "project"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}
