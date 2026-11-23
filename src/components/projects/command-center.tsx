"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectDTO } from "@/lib/workforce";
import { DEFAULT_MAX_MEDIA, MAX_MEDIA_PER_RUN } from "@/lib/creative/prompt";
import { MAX_PROJECT_TASKS } from "@/lib/limits";
import { apiFetch, ApiError } from "@/lib/client";
import { RelativeTime } from "@/components/time";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { StateBadge } from "./status-badge";
import { AccountChoice, type AccountOption } from "./project-accounts";
import { ServerChoice, type ServerOption } from "./project-servers";

interface Option {
  id: string;
  label: string;
}

interface WorkflowOption extends Option {
  /** How many steps of each creative kind the workflow has. */
  media: { image: number; video: number; audio: number; render: number };
  /** How many steps it has in all. */
  steps: number;
}

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function CommandCenter({
  initialProjects,
  managerModels,
  imageModels,
  videoModels,
  speechModels,
  canRender,
  teams,
  workflows,
  servers = [],
  siteAccounts = [],
  chooses = true,
  standInsDefault = true,
}: {
  initialProjects: ProjectDTO[];
  managerModels: Option[];
  /** Models marked for image, video or speech generation. Empty when there are none. */
  imageModels: Option[];
  videoModels: Option[];
  speechModels: Option[];
  /**
   * Whether the project's models are chosen here. For a user they are not:
   * the app chooses, the lists hold one entry each ("yes") for what the
   * installation can do, and the form asks only what the project may make.
   */
  chooses?: boolean;
  /** Whether a run goes on with another model that works, as this installation is set. */
  standInsDefault?: boolean;
  /** Whether this server can join clips into one video (it has ffmpeg). */
  canRender: boolean;
  teams: Option[];
  workflows: WorkflowOption[];
  /** The servers the projects of this account may work on over SSH. Empty for an account that may use none. */
  servers?: ServerOption[];
  /** The site accounts the projects of this account may sign in with. Empty for an account that may use none. */
  siteAccounts?: AccountOption[];
}) {
  const router = useRouter();
  const [projects] = useState(initialProjects);
  const [open, setOpen] = useState(initialProjects.length === 0);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [managerModelRowId, setManager] = useState(managerModels[0]?.id ?? "");
  const [teamId, setTeamId] = useState("");
  const [showAdv, setShowAdv] = useState(false);
  const [maxTasks, setMaxTasks] = useState("12");
  const [maxParallel, setMaxParallel] = useState("3");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [hardQaGate, setHardQaGate] = useState(false);
  const [workflowId, setWorkflowId] = useState("");
  const [imageModelRowId, setImageModel] = useState("");
  const [videoModelRowId, setVideoModel] = useState("");
  const [speechModelRowId, setSpeechModel] = useState("");
  const [memory, setMemory] = useState(false);
  const [standIns, setStandIns] = useState(standInsDefault);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [siteAccountIds, setSiteAccountIds] = useState<string[]>([]);
  const [maxMedia, setMaxMedia] = useState(String(DEFAULT_MAX_MEDIA));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // What the chosen workflow needs, so the form can ask for it up front.
  const workflow = workflows.find((w) => w.id === workflowId) ?? null;
  const needImages = workflow?.media.image ?? 0;
  const needVideos = workflow?.media.video ?? 0;
  const needVoices = workflow?.media.audio ?? 0;
  const needRender = (workflow?.media.render ?? 0) > 0;
  const needMedia = needImages + needVideos + needVoices;
  const showMedia =
    imageModels.length > 0 || videoModels.length > 0 || speechModels.length > 0 || needMedia > 0;
  const missing = (need: number, chosen: string, options: Option[], noun: string, capability: string) =>
    need > 0 && !chosen
      ? !chooses
        ? options.length > 0
          ? `This workflow has ${noun} steps: let the project make ${noun}s.`
          : `This workflow has ${noun} steps, which this installation cannot do yet. An administrator has to set it up.`
        : options.length > 0
          ? `This workflow has ${noun} steps: choose ${noun === "image" ? "an" : "a"} ${noun === "voice-over" ? "speech" : noun} model.`
          : `This workflow has ${noun} steps, but no model is marked for ${capability} yet (Models page).`
      : null;
  const mediaProblem =
    missing(needImages, imageModelRowId, imageModels, "image", "image generation") ??
    missing(needVideos, videoModelRowId, videoModels, "video", "video generation") ??
    missing(needVoices, speechModelRowId, speechModels, "voice-over", "speech generation") ??
    (needRender && !canRender
      ? "This workflow joins its clips into one video, which needs ffmpeg on the server. Ask an administrator to install it, or use a workflow without the joined video."
      : needMedia > Number(maxMedia)
        ? `This workflow generates ${needMedia} images, videos and voice-overs. Raise the media limit in the advanced settings (now ${maxMedia}).`
        : workflow && workflow.steps > Number(maxTasks)
          ? `This workflow has ${workflow.steps} steps. Raise “Max tasks” in the advanced settings (now ${maxTasks}).`
          : null);

  function chooseWorkflow(id: string) {
    setWorkflowId(id);
    // Pre-select the models the workflow needs when there is no choice yet,
    // and make room for its steps and its media.
    const next = workflows.find((w) => w.id === id);
    if (!next) return;
    if (next.media.image > 0 && !imageModelRowId && imageModels[0]) setImageModel(imageModels[0].id);
    if (next.media.video > 0 && !videoModelRowId && videoModels[0]) setVideoModel(videoModels[0].id);
    if (next.media.audio > 0 && !speechModelRowId && speechModels[0]) setSpeechModel(speechModels[0].id);
    const media = next.media.image + next.media.video + next.media.audio;
    if (media > Number(maxMedia) && media <= MAX_MEDIA_PER_RUN) setMaxMedia(String(media));
    if (next.steps > Number(maxTasks) && next.steps <= MAX_PROJECT_TASKS) setMaxTasks(String(next.steps));
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
          managerModelRowId: chooses ? managerModelRowId : null,
          teamId: teamId || null,
          maxTasks: Number(maxTasks),
          maxParallel: Number(maxParallel),
          requiresApproval,
          hardQaGate,
          workflowId: workflowId || null,
          imageModelRowId: imageModelRowId || null,
          videoModelRowId: videoModelRowId || null,
          speechModelRowId: speechModelRowId || null,
          maxMedia: Number(maxMedia),
          memory,
          // Sent only where it was chosen here, and only when it differs from what the installation does anyway.
          ...(chooses && standIns !== standInsDefault ? { standIns } : {}),
          ...(serverIds.length > 0 ? { serverIds } : {}),
          ...(siteAccountIds.length > 0 ? { siteAccountIds } : {}),
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
          {chooses
            ? "You need at least one enabled model (on an enabled provider) before creating a project."
            : "This installation is not ready for work yet. An administrator has to set it up."}
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
              <Field
                label="Goal"
                htmlFor="p-goal"
                hint="Describe what you want produced. Where the work is on your own server, site or API, write how to sign in here (address, user name, password or key): the password is taken out before the goal is stored, kept encrypted, and the agents work with it."
              >
                <Textarea id="p-goal" value={goal} onChange={(e) => setGoal(e.target.value)} required className="min-h-[110px]" placeholder="Build a spec and reference implementation for a token-bucket rate limiter in TypeScript…" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {chooses && (
                  <Field label="Manager model" htmlFor="p-mgr" hint="Plans and synthesizes.">
                    <Select id="p-mgr" value={managerModelRowId} onChange={(e) => setManager(e.target.value)} required>
                      {managerModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </Select>
                  </Field>
                )}
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
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label={chooses ? "Image model" : "Images"} htmlFor="p-img" hint={chooses ? "Generates the images of image tasks." : "Whether the project may make images."}>
                      <Select id="p-img" value={imageModelRowId} onChange={(e) => setImageModel(e.target.value)}>
                        <option value="">No images</option>
                        {imageModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={chooses ? "Video model" : "Videos"} htmlFor="p-vid" hint={chooses ? "Generates the clips of video tasks." : "Whether the project may make videos."}>
                      <Select id="p-vid" value={videoModelRowId} onChange={(e) => setVideoModel(e.target.value)}>
                        <option value="">No videos</option>
                        {videoModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={chooses ? "Speech model" : "Voice-overs"} htmlFor="p-tts" hint={chooses ? "Speaks the voice-overs." : "Whether the project may make voice-overs."}>
                      <Select id="p-tts" value={speechModelRowId} onChange={(e) => setSpeechModel(e.target.value)}>
                        <option value="">No voice-overs</option>
                        {speechModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {needMedia > 0 && (
                    <p className="text-xs text-ink-3">
                      This workflow generates{" "}
                      {[
                        needVideos > 0 ? countLabel(needVideos, "video") : "",
                        needImages > 0 ? countLabel(needImages, "image") : "",
                        needVoices > 0 ? countLabel(needVoices, "voice-over") : "",
                      ]
                        .filter(Boolean)
                        .join(", ")}{" "}
                      per run.{chooses && " Each one is billed by the provider."}
                      {needRender && chooses && " Joining the clips is done on this server and costs nothing at a provider."}
                    </p>
                  )}
                  {mediaProblem && <Alert tone="warn">{mediaProblem}</Alert>}
                </div>
              )}

              {servers.length > 0 && (
                <div className="space-y-1.5" id="p-servers">
                  <p className="label">Servers</p>
                  <ServerChoice options={servers} chosen={serverIds} onChange={setServerIds} />
                </div>
              )}

              {siteAccounts.length > 0 && (
                <div className="space-y-1.5" id="p-accounts">
                  <p className="label">Site accounts</p>
                  <AccountChoice options={siteAccounts} chosen={siteAccountIds} onChange={setSiteAccountIds} />
                </div>
              )}

              <button type="button" onClick={() => setShowAdv((s) => !s)} className="text-xs font-medium text-signal hover:underline">
                {showAdv ? "Hide" : "Show"} advanced settings (limits, memory, approval)
              </button>
              {showAdv && (
                <div className="space-y-4 rounded-md border border-line bg-surface-2/40 p-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Max tasks" htmlFor="p-maxtask">
                      <Input id="p-maxtask" type="number" min={1} max={MAX_PROJECT_TASKS} value={maxTasks} onChange={(e) => setMaxTasks(e.target.value)} />
                    </Field>
                    <Field label="Max parallel" htmlFor="p-par" hint="concurrent tasks">
                      <Input id="p-par" type="number" min={1} max={8} value={maxParallel} onChange={(e) => setMaxParallel(e.target.value)} />
                    </Field>
                    {showMedia && (
                      <Field label="Media limit" htmlFor="p-maxmedia" hint="images, videos and voice-overs per run">
                        <Input id="p-maxmedia" type="number" min={0} max={MAX_MEDIA_PER_RUN} value={maxMedia} onChange={(e) => setMaxMedia(e.target.value)} />
                      </Field>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-ink">Remember earlier runs</p>
                      <p className="text-xs text-ink-3">
                        Each run is told what the last runs delivered, so a project that runs on a schedule builds on
                        its own work instead of repeating it.
                      </p>
                    </div>
                    <Toggle checked={memory} onChange={setMemory} label="Remember earlier runs" />
                  </div>
                  {chooses && (
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm text-ink">Go on with another model</p>
                        <p className="text-xs text-ink-3">
                          When the models of an agent and of the project do not answer, a task is done by another model that
                          works, never one that costs more. Switched off, the task fails instead.
                        </p>
                      </div>
                      <Toggle checked={standIns} onChange={setStandIns} label="Go on with another model" />
                    </div>
                  )}
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
                  <RelativeTime at={p.updatedAt} className="shrink-0 text-xs text-ink-3" />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
