"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectDTO } from "@/lib/workforce";
import { DEFAULT_MAX_MEDIA, MAX_MEDIA_PER_RUN } from "@/lib/creative/prompt";
import { apiFetch, ApiError } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { StateBadge } from "./status-badge";

interface Option {
  id: string;
  label: string;
}

interface WorkflowOption extends Option {
  /** How many images and videos the workflow's steps generate. */
  media: { image: number; video: number };
}

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function CommandCenter({
  initialProjects,
  managerModels,
  imageModels,
  videoModels,
  teams,
  workflows,
}: {
  initialProjects: ProjectDTO[];
  managerModels: Option[];
  /** Models marked for image / video generation. Empty when there are none. */
  imageModels: Option[];
  videoModels: Option[];
  teams: Option[];
  workflows: WorkflowOption[];
}) {
  const router = useRouter();
  const [projects] = useState(initialProjects);
  const [open, setOpen] = useState(initialProjects.length === 0);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [managerModelRowId, setManager] = useState(managerModels[0]?.id ?? "");
  const [teamId, setTeamId] = useState("");
  const [showAdv, setShowAdv] = useState(false);
  const [maxTokens, setMaxTokens] = useState("200000");
  const [maxTasks, setMaxTasks] = useState("12");
  const [maxParallel, setMaxParallel] = useState("3");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [hardQaGate, setHardQaGate] = useState(false);
  const [workflowId, setWorkflowId] = useState("");
  const [imageModelRowId, setImageModel] = useState("");
  const [videoModelRowId, setVideoModel] = useState("");
  const [maxMedia, setMaxMedia] = useState(String(DEFAULT_MAX_MEDIA));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // What the chosen workflow needs, so the form can ask for it up front.
  const workflow = workflows.find((w) => w.id === workflowId) ?? null;
  const needImages = workflow?.media.image ?? 0;
  const needVideos = workflow?.media.video ?? 0;
  const needMedia = needImages + needVideos;
  const showMedia = imageModels.length > 0 || videoModels.length > 0 || needMedia > 0;
  const mediaProblem =
    needImages > 0 && !imageModelRowId
      ? imageModels.length > 0
        ? "This workflow has image steps: choose an image model."
        : "This workflow has image steps, but no model is marked for image generation yet (Models page)."
      : needVideos > 0 && !videoModelRowId
        ? videoModels.length > 0
          ? "This workflow has video steps: choose a video model."
          : "This workflow has video steps, but no model is marked for video generation yet (Models page)."
        : needMedia > Number(maxMedia)
          ? `This workflow generates ${needMedia} images and videos. Raise the media limit in the advanced settings (now ${maxMedia}).`
          : null;

  function chooseWorkflow(id: string) {
    setWorkflowId(id);
    // Pre-select the models the workflow needs when there is no choice yet.
    const next = workflows.find((w) => w.id === id);
    if (!next) return;
    if (next.media.image > 0 && !imageModelRowId && imageModels[0]) setImageModel(imageModels[0].id);
    if (next.media.video > 0 && !videoModelRowId && videoModels[0]) setVideoModel(videoModels[0].id);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ project: ProjectDTO }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          title,
          goal,
          managerModelRowId,
          teamId: teamId || null,
          maxTokens: Number(maxTokens),
          maxTasks: Number(maxTasks),
          maxParallel: Number(maxParallel),
          requiresApproval,
          hardQaGate,
          workflowId: workflowId || null,
          imageModelRowId: imageModelRowId || null,
          videoModelRowId: videoModelRowId || null,
          maxMedia: Number(maxMedia),
        }),
      });
      router.push(`/dashboard/projects/${res.project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create project");
      setLoading(false);
    }
  }

  const canCreate = managerModels.length > 0;

  return (
    <div>
      <PageHeader
        title="AI Manager"
        description="Describe a goal. The Manager plans it into tasks and delegates to your agents."
        actions={!open && canCreate ? <Button onClick={() => setOpen(true)}><Icon name="plus" /> New project</Button> : undefined}
      />

      {!canCreate && (
        <Alert tone="warn">
          You need at least one enabled model (on an enabled provider) before creating a project.
        </Alert>
      )}

      {open && canCreate && (
        <div className="mb-6">
          <Card title="New project">
            <form onSubmit={create} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}
              <Field label="Title" htmlFor="p-title">
                <Input id="p-title" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Design a rate-limiter" />
              </Field>
              <Field label="Goal" htmlFor="p-goal" hint="Describe what you want produced.">
                <Textarea id="p-goal" value={goal} onChange={(e) => setGoal(e.target.value)} required className="min-h-[110px]" placeholder="Build a spec and reference implementation for a token-bucket rate limiter in TypeScript…" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Manager model" htmlFor="p-mgr" hint="Plans and synthesizes.">
                  <Select id="p-mgr" value={managerModelRowId} onChange={(e) => setManager(e.target.value)} required>
                    {managerModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Team" htmlFor="p-team" hint="Or leave as all active agents.">
                  <Select id="p-team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                    <option value="">All active agents</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </Select>
                </Field>
              </div>

              {workflows.length > 0 && (
                <Field label="Workflow" htmlFor="p-wf" hint={workflowId ? "AI-Manager planning is skipped; the workflow's steps run as-is." : "Optional. Leave empty to let the AI Manager plan."}>
                  <Select id="p-wf" value={workflowId} onChange={(e) => chooseWorkflow(e.target.value)}>
                    <option value="">AI Manager plans the tasks</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>{w.label}</option>
                    ))}
                  </Select>
                </Field>
              )}

              {showMedia && (
                <div className="space-y-3">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Image model" htmlFor="p-img" hint="Generates the images of image tasks.">
                      <Select id="p-img" value={imageModelRowId} onChange={(e) => setImageModel(e.target.value)}>
                        <option value="">No images</option>
                        {imageModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Video model" htmlFor="p-vid" hint="Generates the clips of video tasks.">
                      <Select id="p-vid" value={videoModelRowId} onChange={(e) => setVideoModel(e.target.value)}>
                        <option value="">No videos</option>
                        {videoModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {needMedia > 0 && (
                    <p className="text-xs text-ink-3">
                      This workflow generates{" "}
                      {[needVideos > 0 ? countLabel(needVideos, "video") : "", needImages > 0 ? countLabel(needImages, "image") : ""]
                        .filter(Boolean)
                        .join(" and ")}{" "}
                      per run. Each one is billed by the provider.
                    </p>
                  )}
                  {mediaProblem && <Alert tone="warn">{mediaProblem}</Alert>}
                </div>
              )}

              <button type="button" onClick={() => setShowAdv((s) => !s)} className="text-xs font-medium text-signal hover:underline">
                {showAdv ? "Hide" : "Show"} advanced settings (budget, parallelism, approval)
              </button>
              {showAdv && (
                <div className="space-y-4 rounded-md border border-line bg-surface-2/40 p-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Token budget" htmlFor="p-maxtok" hint="run stops if exceeded">
                      <Input id="p-maxtok" type="number" min={1000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
                    </Field>
                    <Field label="Max tasks" htmlFor="p-maxtask">
                      <Input id="p-maxtask" type="number" min={1} max={20} value={maxTasks} onChange={(e) => setMaxTasks(e.target.value)} />
                    </Field>
                    <Field label="Max parallel" htmlFor="p-par" hint="concurrent tasks">
                      <Input id="p-par" type="number" min={1} max={8} value={maxParallel} onChange={(e) => setMaxParallel(e.target.value)} />
                    </Field>
                    {showMedia && (
                      <Field label="Media limit" htmlFor="p-maxmedia" hint="images + videos per run">
                        <Input id="p-maxmedia" type="number" min={0} max={MAX_MEDIA_PER_RUN} value={maxMedia} onChange={(e) => setMaxMedia(e.target.value)} />
                      </Field>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink">Require approval before running</p>
                      <p className="text-xs text-ink-3">An admin must approve each run.</p>
                    </div>
                    <Toggle checked={requiresApproval} onChange={setRequiresApproval} label="Require approval" />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink">Hard QA gate</p>
                      <p className="text-xs text-ink-3">Block a “succeeded” result unless the reviewer verdict is pass.</p>
                    </div>
                    <Toggle checked={hardQaGate} onChange={setHardQaGate} label="Hard QA gate" />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                {initialProjects.length > 0 && (
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                )}
                <Button type="submit" loading={loading} disabled={Boolean(mediaProblem)}>Create project</Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {projects.length === 0 ? (
        !open && <EmptyState title="No projects yet" description="Create a project to put your AI workforce to work." />
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/dashboard/projects/${p.id}`} className="block">
              <Card className="transition hover:border-line-strong">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{p.title}</span>
                      <StateBadge state={p.status} />
                    </div>
                    <p className="mt-1 line-clamp-1 text-sm text-ink-3">{p.goal}</p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-3">{formatRelative(p.updatedAt)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
