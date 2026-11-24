"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectResult, ResultBuilt, ResultFile } from "@/lib/result";
import type { MediaAssetDTO } from "@/lib/media/dto";
import { KIND_LABEL, byFolder, baseName, isMarkdown, sizeLabel } from "@/lib/result/kinds";
import { ApiError, apiFetch } from "@/lib/client";
import { Alert, Button, Spinner, cn } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { Markdown } from "@/components/markdown";
import { MediaView } from "@/components/media/media-view";
import { DateTime, RelativeTime } from "@/components/time";

/**
 * What the project made, as the things they are: the web site, shown; the
 * pictures, videos and voice-overs; the packages that were built; and every
 * file, to look at and to download. It stands above the tasks: a finished
 * project is its result, not the words about it.
 */

const FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";

const KIND_ICON: Record<ResultFile["kind"], IconName> = {
  page: "browser",
  style: "file",
  script: "api",
  document: "knowledge",
  data: "file",
  image: "image",
  code: "api",
  text: "file",
};

/** A path as part of an address. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function seconds(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export interface OpenFile {
  path: string;
  /** Counts up with each request, so that the same file can be asked for again. */
  n: number;
}

export function ProjectResultCard({
  projectId,
  result,
  onResult,
  assets,
  running,
  mayOperate,
  canFix,
  onFix,
  open,
  buildNote,
  showSetup,
}: {
  projectId: string;
  result: ProjectResult;
  /** The result has changed here: a build ended, a built file was removed. */
  onResult: (result: ProjectResult) => void;
  /** The pictures, videos and voice-overs of the last run. */
  assets: MediaAssetDTO[];
  /** A run of the project is under way. */
  running: boolean;
  /** Whether this account may build and change the project. */
  mayOperate: boolean;
  /** Whether a run can be started now, for the AI to put a failed build right. */
  canFix: boolean;
  onFix: () => void;
  /** A file to show, asked for elsewhere on the page. */
  open: OpenFile | null;
  /** What the run's own build is doing, while it does. */
  buildNote: string | null;
  /** Whether the viewer is shown how the installation is set up. */
  showSetup: boolean;
}) {
  const { files, site, preview, built, build } = result;
  const media = assets.filter((a) => a.status !== "failed");

  // ── The site ──
  const [page, setPage] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [reloads, setReloads] = useState(0);
  const shownPage = page && site?.pages.includes(page) ? page : site?.entry ?? null;
  // The preview loads anew when a file of the project has changed.
  const stamp = useMemo(() => files.reduce((max, f) => Math.max(max, f.updatedAt), 0), [files]);

  // ── One file ──
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ path: string; text: string } | "loading" | "failed" | null>(null);
  const [asSource, setAsSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const viewer = useRef<HTMLDivElement>(null);
  const file = files.find((f) => f.path === selected) ?? null;
  const fileStamp = file?.updatedAt ?? 0;
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  function show(path: string) {
    setSelected(path);
    setAsSource(false);
    setShowFiles(true);
    // After the viewer has been drawn.
    setTimeout(() => viewer.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
  }

  useEffect(() => {
    if (open && paths.has(open.path)) show(open.path);
    // Only when something else asks: not when the list of files changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.n]);

  useEffect(() => {
    if (!file || !result.workspaceId) {
      setContent(null);
      return;
    }
    let stale = false;
    setContent((now) => (now && typeof now === "object" && now.path === file.path ? now : "loading"));
    apiFetch<{ file: { content: string } }>(`/api/workspaces/${result.workspaceId}/files/${file.id}`)
      .then((res) => {
        if (!stale) setContent({ path: file.path, text: res.file.content });
      })
      .catch(() => {
        if (!stale) setContent("failed");
      });
    return () => {
      stale = true;
    };
    // The file is read again when it has changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, fileStamp, result.workspaceId]);

  // ── Building ──
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  // What a failed build said is shown without being asked for: it is why there is no package.
  const [logChoice, setShowLog] = useState<boolean | null>(null);
  const busy = building || Boolean(build?.running) || buildNote !== null;

  async function buildNow() {
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await apiFetch<{ result: ProjectResult }>(`/api/projects/${projectId}/build`, { method: "POST" });
      onResult(res.result);
      setShowLog(res.result.build?.last?.ok === false);
    } catch (err) {
      setBuildError(err instanceof ApiError ? err.message : "The build could not be started");
    } finally {
      setBuilding(false);
    }
  }

  async function removeBuilt(one: ResultBuilt) {
    try {
      await apiFetch(`/api/projects/${projectId}/built/${one.id}`, { method: "DELETE" });
      onResult({ ...result, built: built.filter((b) => b.id !== one.id) });
    } catch (err) {
      setBuildError(err instanceof ApiError ? err.message : "The file could not be removed");
    }
  }

  const nothing = files.length === 0 && built.length === 0 && media.length === 0;
  if (nothing) {
    if (!running) return null;
    return (
      <section className="card mb-6" data-testid="project-result">
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-ink-3">
          <Spinner size={14} /> What the project makes appears here as it is made.
        </div>
      </section>
    );
  }

  const summary = [
    files.length > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"} · ${sizeLabel(result.bytes)}` : "",
    site ? (site.pages.length === 1 ? "a web page" : `a web site of ${site.pages.length} pages`) : "",
    built.length > 0 ? `${built.length} built ${built.length === 1 ? "file" : "files"}` : "",
    media.length > 0 ? `${media.length} ${media.length === 1 ? "media file" : "media files"}` : "",
  ].filter(Boolean);

  const last = build?.last ?? null;
  const showLog = logChoice ?? (last !== null && !last.ok);
  const groups = byFolder(files);

  return (
    <section className="card mb-6" data-testid="project-result">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon name="result" size={16} /> Result
          </h2>
          <p className="mt-0.5 text-xs text-ink-2" data-testid="result-summary">
            {summary.join(" · ")}
            {running ? " · still being made" : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <a href={result.download.url} download={result.download.name} className="btn-primary px-3 py-1.5 text-xs" data-testid="result-download">
            <Icon name="download" size={14} /> Download all (.zip)
          </a>
        </div>
      </header>

      <div className="space-y-6 p-5">
        {/* ── The web site, shown ── */}
        {site && preview && shownPage && (
          <div data-testid="result-site">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-xs font-semibold uppercase tracking-wider text-ink-3">
                {site.pages.length === 1 ? "Web page" : "Web site"}
              </h3>
              {site.pages.length > 1 && (
                <select
                  aria-label="Page"
                  value={shownPage}
                  onChange={(e) => setPage(e.target.value)}
                  className="mono max-w-[14rem] rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink"
                >
                  {site.pages.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" onClick={() => setNarrow((v) => !v)} className="btn-ghost px-2 py-1 text-xs" aria-pressed={narrow} title="Show it as wide as a phone, or as wide as there is room">
                {narrow ? "Full width" : "Phone width"}
              </button>
              <button type="button" onClick={() => setReloads((n) => n + 1)} className="btn-ghost px-2 py-1 text-xs" title="Load the page again">
                <Icon name="refresh" size={13} /> Reload
              </button>
              <a href={`${preview.base}${encodePath(shownPage)}`} target="_blank" rel="noreferrer noopener" className="btn-ghost px-2 py-1 text-xs" data-testid="result-site-open">
                <Icon name="open" size={13} /> Open in a new tab
              </a>
            </div>
            <div className="overflow-hidden rounded-md border border-line bg-white">
              <iframe
                key={`${shownPage}:${stamp}:${reloads}`}
                src={`${preview.base}${encodePath(shownPage)}`}
                title={`Preview of ${shownPage}`}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                loading="lazy"
                data-testid="result-site-frame"
                className={cn("mx-auto block h-[32rem] bg-white", narrow ? "w-[390px] max-w-full border-x border-line" : "w-full")}
              />
            </div>
            <p className="mt-2 text-xs text-ink-3">
              This is the page as a browser shows it, with its style sheets and scripts. It runs in a sandbox, apart from this dashboard. The
              address of the new tab works without signing in until <DateTime at={preview.expiresAt} />: anyone you give it to can look at the
              files of this project until then.
            </p>
          </div>
        )}

        {/* ── Pictures, videos, voice-overs ── */}
        {media.length > 0 && (
          <div data-testid="result-media">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Pictures, videos and voice-overs ({media.length})</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {media.map((asset) => (
                <div key={asset.id} className="min-w-0">
                  <MediaView asset={asset} heightClass="h-56" />
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                    <span className="truncate" title={asset.prompt}>
                      {asset.status === "pending" ? "still being made" : asset.prompt}
                    </span>
                    {asset.url && (
                      <a href={`${asset.url}?download=1`} className="btn-ghost shrink-0 px-2 py-1 text-xs" download>
                        <Icon name="download" size={13} /> Download
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── What was built ── */}
        {(build || built.length > 0) && (
          <div data-testid="result-built">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Built files</h3>
            {built.length > 0 && (
              <ul className="mb-3 divide-y divide-line rounded-md border border-line">
                {built.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                    <Icon name="package" size={18} className="shrink-0 text-signal" />
                    <div className="min-w-0 flex-1">
                      <p className="mono truncate text-sm text-ink" title={b.path}>
                        {b.name}
                      </p>
                      <p className="text-xs text-ink-3">
                        {sizeLabel(b.size)} · built <RelativeTime at={b.createdAt} /> ·{" "}
                        {b.current ? "from the files as they are now" : <span className="text-warn">from the files as they were before the last change</span>}
                      </p>
                    </div>
                    <a href={b.url} download={b.name} className="btn-primary shrink-0 px-3 py-1.5 text-xs" data-testid="built-download">
                      <Icon name="download" size={14} /> Download
                    </a>
                    {mayOperate && (
                      <button type="button" onClick={() => void removeBuilt(b)} className="btn-ghost shrink-0 px-2 py-1.5 text-xs" title="Remove this built file. The files it was built from stay.">
                        <Icon name="trash" size={14} />
                        <span className="sr-only">Remove {b.name}</span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {build && (
              <div className="rounded-md border border-line bg-surface-2/40 p-3 text-sm" data-testid="result-build">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-1 text-ink-2">
                    These files are built into a package with {build.plan.label} (<span className="mono text-xs">{build.plan.file}</span>).
                    {built.length === 0 && !busy && last === null && build.runner ? " It has not been built yet." : ""}
                  </p>
                  {build.runner && mayOperate && (
                    <Button onClick={() => void buildNow()} loading={busy} disabled={busy || running} data-testid="build-now" title={running ? "The run builds it itself when its tasks are done" : undefined}>
                      <Icon name="package" size={15} /> {last || built.length > 0 ? "Build again" : "Build"}
                    </Button>
                  )}
                </div>
                {busy && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-ink-3" data-testid="build-busy">
                    <Spinner size={12} /> {buildNote ?? "Building. The first build of a project fetches what it is built with, which can take some minutes."}
                  </p>
                )}
                {!build.runner && (
                  <p className="mt-2 text-xs text-ink-3" data-testid="build-no-runner">
                    This server has nothing to build with, so the package is not made here: download the files and build them with {build.plan.label}.
                    {showSetup ? (
                      <>
                        {" "}
                        A runner that builds is set up with <span className="mono">scripts/host/runner-service.sh</span>.
                      </>
                    ) : (
                      " An administrator can set that up."
                    )}
                  </p>
                )}
                {buildError && (
                  <div className="mt-2">
                    <Alert tone="danger">{buildError}</Alert>
                  </div>
                )}
                {last && !busy && (
                  <div className="mt-2" data-testid="build-last">
                    <p className={cn("text-xs", last.ok ? "text-ok" : "text-danger")}>
                      {last.ok ? "The last build succeeded" : `The last build failed${last.exitCode !== null ? ` (exit code ${last.exitCode})` : ""}`}
                      <span className="text-ink-3">
                        {" "}
                        · <RelativeTime at={last.at} />
                        {last.durationMs !== null ? ` · it took ${seconds(last.durationMs)}` : ""}
                        {last.current ? "" : " · the files have changed since"}
                      </span>
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {last.log && (
                        <button type="button" onClick={() => setShowLog(!showLog)} className="text-xs font-medium text-signal hover:underline" aria-expanded={showLog}>
                          {showLog ? "Hide" : "View"} what the build said
                        </button>
                      )}
                      {!last.ok && mayOperate && build.runner && (
                        <Button variant="ghost" onClick={onFix} disabled={!canFix} data-testid="build-fix" title="A run that keeps every task that is done, and gives one more task to the agent that wrote the build: make it build">
                          <Icon name="tool" size={14} /> Let the AI fix it
                        </Button>
                      )}
                    </div>
                    {showLog && last.log && (
                      <pre className="mono mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 text-[11px] leading-snug text-ink-2" data-testid="build-log">
                        {last.log}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Every file ── */}
        {files.length > 0 && (
          <div data-testid="result-files">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setShowFiles((v) => !v)} className="mr-auto flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3 hover:text-ink" aria-expanded={showFiles}>
                <Icon name="down" size={12} className={showFiles ? "" : "-rotate-90"} /> Files ({files.length})
              </button>
              <Link href={`/dashboard/projects/${projectId}/workspace`} className="btn-ghost px-2 py-1 text-xs" title="Change the files, run a program on them, keep versions">
                Edit in the workspace
              </Link>
            </div>
            {showFiles && (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
                <nav aria-label="Files of the project" className="max-h-80 overflow-auto rounded-md border border-line lg:max-h-[32rem]">
                  {groups.map((group) => (
                    <div key={group.folder || "/"}>
                      {group.folder && (
                        <p className="mono sticky top-0 flex items-center gap-1.5 border-b border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-3">
                          <Icon name="folder" size={12} /> <span className="truncate">{group.folder}/</span>
                        </p>
                      )}
                      <ul>
                        {group.files.map((f) => (
                          <li key={f.id}>
                            <button
                              type="button"
                              onClick={() => show(f.path)}
                              aria-current={f.path === selected ? "true" : undefined}
                              className={cn(
                                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-surface-2",
                                f.path === selected ? "bg-signal/10 text-ink" : "text-ink-2",
                              )}
                            >
                              <Icon name={KIND_ICON[f.kind]} size={13} className="shrink-0 text-ink-3" />
                              <span className="mono min-w-0 flex-1 truncate" title={f.path}>
                                {baseName(f.path)}
                              </span>
                              <span className="shrink-0 text-[11px] text-ink-3">{sizeLabel(f.size)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </nav>
                <div ref={viewer} className="min-w-0 rounded-md border border-line" data-testid="result-viewer">
                  {!file ? (
                    <p className="p-4 text-sm text-ink-3">Choose a file to look at it.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                        <div className="mr-auto min-w-0">
                          <p className="mono truncate text-xs text-ink" title={file.path}>
                            {file.path}
                          </p>
                          <p className="text-[11px] text-ink-3">
                            {KIND_LABEL[file.kind]} · {sizeLabel(file.size)}
                            {file.task !== null ? ` · written by task #${file.task}` : ""}
                          </p>
                        </div>
                        {(isMarkdown(file.path) || (preview && (file.kind === "page" || file.kind === "image"))) && (
                          <button type="button" onClick={() => setAsSource((v) => !v)} className="btn-ghost px-2 py-1 text-xs" aria-pressed={asSource}>
                            {asSource ? (file.kind === "page" ? "Show the page" : file.kind === "image" ? "Show the picture" : "Show the document") : "Show the source"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-ghost px-2 py-1 text-xs"
                          disabled={!content || typeof content !== "object"}
                          onClick={() => {
                            if (!content || typeof content !== "object") return;
                            void navigator.clipboard?.writeText(content.text).then(() => {
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            });
                          }}
                        >
                          <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}
                        </button>
                        <a href={`/api/projects/${projectId}/file?path=${encodeURIComponent(file.path)}`} download={baseName(file.path)} className="btn-ghost px-2 py-1 text-xs" data-testid="file-download">
                          <Icon name="download" size={13} /> Download
                        </a>
                      </div>
                      {file.kind === "page" && preview && !asSource ? (
                        <iframe
                          key={`${file.path}:${file.updatedAt}`}
                          src={`${preview.base}${encodePath(file.path)}`}
                          title={`Preview of ${file.path}`}
                          sandbox={FRAME_SANDBOX}
                          referrerPolicy="no-referrer"
                          className="block h-[28rem] w-full bg-white"
                        />
                      ) : file.kind === "image" && preview && !asSource ? (
                        <div className="flex max-h-[28rem] items-center justify-center overflow-auto bg-white p-4">
                          {/* A picture an agent wrote, served from the sandboxed preview: as a picture it runs nothing. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`${preview.base}${encodePath(file.path)}?v=${file.updatedAt}`} alt={file.path} className="max-h-[26rem] max-w-full" />
                        </div>
                      ) : content === "loading" || content === null ? (
                        <p className="flex items-center gap-2 p-4 text-sm text-ink-3">
                          <Spinner size={14} /> Loading…
                        </p>
                      ) : content === "failed" ? (
                        <p className="p-4 text-sm text-danger">The file could not be read.</p>
                      ) : isMarkdown(file.path) && !asSource ? (
                        <div className="max-h-[32rem] overflow-auto p-4" data-testid="file-document">
                          <Markdown source={content.text} files={paths} onFile={show} />
                        </div>
                      ) : (
                        <pre className="mono max-h-[32rem] overflow-auto whitespace-pre p-3 text-[12px] leading-snug text-ink-2" data-testid="file-source">
                          {content.text}
                        </pre>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
