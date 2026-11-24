"use client";

import { useState } from "react";
import type { WorkflowDTO } from "@/lib/workforce";
import { ASPECT_RATIOS, MAX_VIDEO_SECONDS } from "@/lib/adapters/media-protocol";
import { MAX_SPEECH_SPEED, MIN_SPEECH_SPEED, VOICE_PATTERN, type TaskKind } from "@/lib/creative/prompt";
import {
  REEL_DEFAULT_CLIP_SECONDS,
  REEL_DEFAULT_SCENES,
  REEL_MAX_CLIP_SECONDS,
  REEL_MAX_SCENES,
  needsInWords,
  reelWorkflowTemplate,
  templateNeeds,
} from "@/lib/creative/templates";
import { apiFetch, ApiError } from "@/lib/client";
import { MAX_PROJECT_TASKS } from "@/lib/limits";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";

interface StepForm {
  title: string;
  objective: string;
  acceptanceCriteria: string;
  role: string;
  outputFile: string;
  dependsOn: string; // csv of step numbers
  kind: TaskKind;
  aspectRatio: string;
  durationSeconds: string;
  resolution: string;
  /** Kept as saved; the builder has no field for it. */
  size: string;
  /** Voice-over: the voice, and how fast it speaks. */
  voice: string;
  speed: string;
  /** Video: the number of the image step whose picture the clip starts from. */
  imageFrom: string;
  /** Joined video: burn the spoken words in, keep the clips' own sound, fill the frame. */
  subtitles: boolean;
  keepClipAudio: boolean;
  fit: "" | "contain" | "cover";
}

const emptyStep: StepForm = {
  title: "",
  objective: "",
  acceptanceCriteria: "",
  role: "",
  outputFile: "",
  dependsOn: "",
  kind: "text",
  aspectRatio: "",
  durationSeconds: "",
  resolution: "",
  size: "",
  voice: "",
  speed: "",
  imageFrom: "",
  subtitles: true,
  keepClipAudio: false,
  fit: "",
};

const KIND_NOUN: Record<TaskKind, string> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "voice-over",
  render: "joined video",
};

type SavedStep = WorkflowDTO["steps"][number];

function toForm(s: Pick<SavedStep, "title" | "objective" | "role"> & Partial<SavedStep>): StepForm {
  return {
    title: s.title,
    objective: s.objective,
    acceptanceCriteria: s.acceptanceCriteria ?? "",
    role: s.role,
    outputFile: s.outputFile ?? "",
    dependsOn: (s.dependsOn ?? []).join(","),
    kind: s.kind ?? "text",
    aspectRatio: s.media?.aspectRatio ?? "",
    durationSeconds: s.media?.durationSeconds ? String(s.media.durationSeconds) : "",
    resolution: s.media?.resolution ?? "",
    size: s.media?.size ?? "",
    voice: s.media?.voice ?? "",
    speed: s.media?.speed ? String(s.media.speed) : "",
    imageFrom: s.media?.imageFrom ? String(s.media.imageFrom) : "",
    subtitles: s.media?.subtitles ?? true,
    keepClipAudio: s.media?.keepClipAudio ?? false,
    fit: s.media?.fit ?? "",
  };
}

function parseDeps(csv: string): number[] {
  return csv
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Rewrite the step numbers every step refers to, after steps moved or went away. */
function renumber(steps: StepForm[], newNumber: (old: number) => number | null): StepForm[] {
  return steps.map((s) => {
    const from = parseInt(s.imageFrom, 10);
    const image = Number.isFinite(from) && from > 0 ? newNumber(from) : null;
    return {
      ...s,
      dependsOn: parseDeps(s.dependsOn)
        .map(newNumber)
        .filter((n): n is number => n !== null)
        .join(","),
      imageFrom: image === null ? "" : String(image),
    };
  });
}

function mediaCounts(steps: { kind?: TaskKind }[]): string {
  const count = (kind: TaskKind) => steps.filter((s) => s.kind === kind).length;
  const part = (n: number, one: string, many: string) => (n > 0 ? `${n} ${n === 1 ? one : many}` : "");
  return [
    part(count("video"), "video", "videos"),
    part(count("image"), "image", "images"),
    part(count("audio"), "voice-over", "voice-overs"),
    count("render") > 0 ? "joined into one video" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function Builder({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: WorkflowDTO;
  onSaved: (w: WorkflowDTO) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [steps, setSteps] = useState<StepForm[]>(
    initial?.steps.length ? initial.steps.map(toForm) : [{ ...emptyStep }],
  );
  const [reelScenes, setReelScenes] = useState(String(REEL_DEFAULT_SCENES));
  const [reelSeconds, setReelSeconds] = useState(String(REEL_DEFAULT_CLIP_SECONDS));
  const [reelKeyframes, setReelKeyframes] = useState(false);
  const [reelVoice, setReelVoice] = useState(false);
  const [reelVoiceName, setReelVoiceName] = useState("");
  const [reelJoin, setReelJoin] = useState(false);
  const [reelSubtitles, setReelSubtitles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update(i: number, patch: Partial<StepForm>) {
    setSteps((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function move(i: number, dir: -1 | 1) {
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j]!, n[i]!];
      // The two steps swapped numbers: what depends on them follows.
      return renumber(n, (old) => (old === i + 1 ? j + 1 : old === j + 1 ? i + 1 : old));
    });
  }
  function removeStep(i: number) {
    setSteps((s) =>
      renumber(
        s.filter((_, idx) => idx !== i),
        (old) => (old === i + 1 ? null : old > i + 1 ? old - 1 : old),
      ),
    );
  }

  function applyReelTemplate() {
    const hasContent = steps.some((s) => s.title.trim() || s.objective.trim());
    if (hasContent && !confirm("Replace the steps below with the Reel template?")) return;
    const template = reelWorkflowTemplate({
      scenes: Number(reelScenes) || undefined,
      clipSeconds: Number(reelSeconds) || undefined,
      keyframes: reelKeyframes,
      voiceOver: reelVoice,
      voice: reelVoiceName.trim() || undefined,
      join: reelJoin,
      subtitles: reelSubtitles,
    });
    setName((current) => current.trim() || template.name);
    setDescription((current) => current.trim() || template.description);
    setSteps(template.steps.map(toForm));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const kept = steps
      .map((s, i) => ({ s, number: i + 1 }))
      .filter(({ s }) => s.title.trim() && s.objective.trim() && s.role.trim());
    if (kept.length < steps.length) {
      // Dropping a step silently would shift the numbers other steps depend on.
      const unfinished = steps.length - kept.length;
      setError(
        `${unfinished === 1 ? "One step is" : `${unfinished} steps are`} missing a title, an agent role or an objective. Fill ${unfinished === 1 ? "it" : "them"} in or remove ${unfinished === 1 ? "it" : "them"}.`,
      );
      return;
    }
    for (const { s, number } of kept) {
      const later = parseDeps(s.dependsOn).find((d) => d >= number);
      if (later !== undefined) {
        setError(`Step ${number} depends on step ${later}. A step can only depend on steps before it.`);
        return;
      }
      if (s.kind === "video" && s.imageFrom) {
        const from = Number(s.imageFrom);
        if (!(from >= 1 && from < number) || steps[from - 1]?.kind !== "image") {
          setError(`Step ${number} starts from the image of step ${s.imageFrom}, which is not an image step before it.`);
          return;
        }
      }
      if (s.kind === "audio" && s.voice.trim() && !VOICE_PATTERN.test(s.voice.trim())) {
        setError(`Step ${number}: the voice is the provider's name for it, such as "alloy".`);
        return;
      }
    }

    const payloadSteps = kept.map(({ s }) => {
      const number = (value: string) => (value.trim() ? Number(value) : undefined);
      const media =
        s.kind === "text"
          ? undefined
          : s.kind === "audio"
            ? {
                // How long it should take to say: the agent writes that many words.
                durationSeconds: number(s.durationSeconds),
                voice: s.voice.trim() || undefined,
                speed: number(s.speed),
              }
            : s.kind === "render"
              ? {
                  aspectRatio: s.aspectRatio.trim() || undefined,
                  subtitles: s.subtitles,
                  keepClipAudio: s.keepClipAudio || undefined,
                  fit: s.fit || undefined,
                }
              : {
                  aspectRatio: s.aspectRatio.trim() || undefined,
                  durationSeconds: s.kind === "video" ? number(s.durationSeconds) : undefined,
                  resolution: s.resolution.trim() || undefined,
                  size: s.size.trim() || undefined,
                  imageFrom: s.kind === "video" ? number(s.imageFrom) : undefined,
                };
      // A clip that starts from a picture needs that picture first.
      const deps = parseDeps(s.dependsOn);
      if (s.kind === "video" && s.imageFrom && !deps.includes(Number(s.imageFrom))) deps.push(Number(s.imageFrom));
      return {
        title: s.title.trim(),
        objective: s.objective.trim(),
        acceptanceCriteria: s.acceptanceCriteria.trim() || undefined,
        role: s.role.trim(),
        // Only a text step delivers a workspace file.
        outputFile: s.kind === "text" ? s.outputFile.trim() || undefined : undefined,
        dependsOn: deps.sort((a, b) => a - b),
        kind: s.kind,
        media,
      };
    });

    setLoading(true);
    try {
      const body = JSON.stringify({ name, description: description || undefined, steps: payloadSteps });
      const res = editing
        ? await apiFetch<{ workflow: WorkflowDTO }>(`/api/workflows/${initial!.id}`, { method: "PATCH", body })
        : await apiFetch<{ workflow: WorkflowDTO }>("/api/workflows", { method: "POST", body });
      onSaved(res.workflow);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save workflow");
      setLoading(false);
    }
  }

  const counts = mediaCounts(steps);

  return (
    <form onSubmit={save} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {!editing && (
        <div className="rounded-md border border-line bg-surface-2/40 p-3">
          <p className="text-sm font-medium text-ink">Start from the Reel template</p>
          <p className="mt-0.5 text-xs text-ink-3">
            A short vertical video: script, storyboard, one generated clip per scene, a cover image and a caption.
            Tick what else it should do. Each option adds steps, and what they generate is billed by the provider.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Scenes" htmlFor="w-reel-scenes">
              <Select id="w-reel-scenes" value={reelScenes} onChange={(e) => setReelScenes(e.target.value)} className="w-24">
                {Array.from({ length: REEL_MAX_SCENES }, (_, i) => String(i + 1)).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Seconds per clip" htmlFor="w-reel-seconds">
              <Input
                id="w-reel-seconds"
                type="number"
                min={1}
                max={REEL_MAX_CLIP_SECONDS}
                step={1}
                value={reelSeconds}
                onChange={(e) => setReelSeconds(e.target.value)}
                className="w-32"
              />
            </Field>
            {reelVoice && (
              <Field label="Voice" htmlFor="w-reel-voice">
                <Input
                  id="w-reel-voice"
                  value={reelVoiceName}
                  onChange={(e) => setReelVoiceName(e.target.value)}
                  placeholder="provider default"
                  maxLength={64}
                  className="w-44"
                />
              </Field>
            )}
          </div>
          <ul className="mt-3 space-y-1.5 text-sm text-ink-2">
            <li>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-1 accent-current" checked={reelKeyframes} onChange={(e) => setReelKeyframes(e.target.checked)} />
                <span>
                  Keyframes
                  <span className="block text-xs text-ink-3">
                    An image is generated for each scene first, and the scene&apos;s clip starts from it (image-to-video). Keeps the scenes looking alike. Needs a video model that takes a first frame.
                  </span>
                </span>
              </label>
            </li>
            <li>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-1 accent-current" checked={reelVoice} onChange={(e) => setReelVoice(e.target.checked)} />
                <span>
                  Voice-over
                  <span className="block text-xs text-ink-3">Each scene&apos;s line of the script is spoken. The project needs a speech model.</span>
                </span>
              </label>
            </li>
            <li>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-1 accent-current" checked={reelJoin} onChange={(e) => setReelJoin(e.target.checked)} />
                <span>
                  Join into one video
                  <span className="block text-xs text-ink-3">
                    The clips are joined in order, with the voice-overs over them, on this server. It needs ffmpeg installed there and costs nothing at a provider. Without it the clips stay separate files.
                  </span>
                </span>
              </label>
            </li>
            {reelJoin && reelVoice && (
              <li className="pl-6">
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="accent-current" checked={reelSubtitles} onChange={(e) => setReelSubtitles(e.target.checked)} />
                  Burn the spoken words in as subtitles
                </label>
              </li>
            )}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" variant="ghost" onClick={applyReelTemplate}>
              <Icon name="video" size={16} /> Use template
            </Button>
            <ReelNeeds
              options={{
                scenes: Number(reelScenes) || undefined,
                clipSeconds: Number(reelSeconds) || undefined,
                keyframes: reelKeyframes,
                voiceOver: reelVoice,
                join: reelJoin,
                subtitles: reelSubtitles,
              }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="w-name">
          <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Spec → Build → Review" />
        </Field>
        <Field label="Description" htmlFor="w-desc">
          <Input id="w-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </Field>
      </div>

      <p className="text-xs text-ink-3">
        A step goes to the agent whose name or role matches its agent role, or to the first agent of the team when none
        does. A step that delivers an image, a video or a voice-over has its agent write the prompt (for a voice-over:
        the words to speak); the project&apos;s image, video or speech model then generates one file from it. A step
        that joins clips needs no agent: this server does it.
        {counts && ` This workflow makes ${counts} per run.`}
        {steps.length > MAX_PROJECT_TASKS && ` A workflow can have ${MAX_PROJECT_TASKS} steps; this one has ${steps.length}.`}
      </p>

      <div className="space-y-3">
        {steps.map((s, i) => (
          <div key={i} className="rounded-md border border-line bg-surface-2/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-3">Step {i + 1}</span>
              <div className="flex gap-1">
                {/* Drawn icons: the arrow and cross characters are missing from some fonts. */}
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="btn-ghost px-2 py-1 text-xs" aria-label={`Move step ${i + 1} up`} title="Move up">
                  <Icon name="up" size={14} />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="btn-ghost px-2 py-1 text-xs" aria-label={`Move step ${i + 1} down`} title="Move down">
                  <Icon name="down" size={14} />
                </button>
                <button type="button" onClick={() => removeStep(i)} className="btn-ghost px-2 py-1 text-xs text-danger" aria-label={`Remove step ${i + 1}`} title="Remove">
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={s.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Title" aria-label={`Step ${i + 1} title`} />
              <Input value={s.role} onChange={(e) => update(i, { role: e.target.value })} placeholder="Agent role (e.g. Engineer)" aria-label={`Step ${i + 1} agent role`} />
            </div>
            <Textarea
              value={s.objective}
              onChange={(e) => update(i, { objective: e.target.value })}
              placeholder={
                s.kind === "text"
                  ? "Objective"
                  : s.kind === "audio"
                    ? "What is said. The agent writes the exact words that are spoken."
                    : s.kind === "render"
                      ? "A note for people. The step joins the videos (else the images) of the steps it depends on, in order, with their voice-overs."
                      : `What the ${s.kind} should show. The agent turns this into the prompt.`
              }
              aria-label={`Step ${i + 1} objective`}
              className="mt-2 min-h-[56px]"
            />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Select
                value={s.kind}
                onChange={(e) => {
                  const kind = e.target.value as TaskKind;
                  // A step that joins clips has nothing for an agent to do: fill in what the form requires.
                  update(
                    i,
                    kind === "render"
                      ? {
                          kind,
                          role: s.role.trim() || "Video Artist",
                          objective: s.objective.trim() || "Join the clips of the steps this one depends on into one video.",
                        }
                      : { kind },
                  );
                }}
                aria-label={`Step ${i + 1} delivers`}
              >
                <option value="text">Delivers text</option>
                <option value="image">Delivers an image</option>
                <option value="video">Delivers a video</option>
                <option value="audio">Delivers a voice-over</option>
                <option value="render">Joins clips into one video</option>
              </Select>
              <Input value={s.dependsOn} onChange={(e) => update(i, { dependsOn: e.target.value })} placeholder="Depends on steps (e.g. 1,2)" aria-label={`Step ${i + 1} depends on steps`} />
            </div>
            {s.kind === "text" ? (
              <Input
                value={s.outputFile}
                onChange={(e) => update(i, { outputFile: e.target.value })}
                placeholder="Output file (optional, e.g. src/x.ts)"
                aria-label={`Step ${i + 1} output file`}
                className="mono mt-2"
              />
            ) : s.kind === "audio" ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Input
                  value={s.voice}
                  onChange={(e) => update(i, { voice: e.target.value })}
                  placeholder="Voice (provider default)"
                  aria-label={`Step ${i + 1} voice`}
                  maxLength={64}
                />
                <Input
                  type="number"
                  min={1}
                  max={MAX_VIDEO_SECONDS}
                  step={1}
                  value={s.durationSeconds}
                  onChange={(e) => update(i, { durationSeconds: e.target.value })}
                  placeholder="About how many seconds"
                  aria-label={`Step ${i + 1} length in seconds`}
                />
                <Input
                  type="number"
                  min={MIN_SPEECH_SPEED}
                  max={MAX_SPEECH_SPEED}
                  step={0.05}
                  value={s.speed}
                  onChange={(e) => update(i, { speed: e.target.value })}
                  placeholder="Speed (1 is normal)"
                  aria-label={`Step ${i + 1} speaking speed`}
                />
              </div>
            ) : s.kind === "render" ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Select value={s.aspectRatio} onChange={(e) => update(i, { aspectRatio: e.target.value })} aria-label={`Step ${i + 1} aspect ratio`}>
                  <option value="">Frame: as the first clip</option>
                  {s.aspectRatio && !(ASPECT_RATIOS as readonly string[]).includes(s.aspectRatio) && (
                    <option value={s.aspectRatio}>{s.aspectRatio}</option>
                  )}
                  {ASPECT_RATIOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Select value={s.fit} onChange={(e) => update(i, { fit: e.target.value as StepForm["fit"] })} aria-label={`Step ${i + 1} fit`}>
                  <option value="">Show each clip whole (bars if needed)</option>
                  <option value="cover">Fill the frame (crops the edges)</option>
                </Select>
                <div className="flex flex-col justify-center gap-1 text-xs text-ink-2">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" className="accent-current" checked={s.subtitles} onChange={(e) => update(i, { subtitles: e.target.checked })} />
                    Subtitles from the voice-overs
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" className="accent-current" checked={s.keepClipAudio} onChange={(e) => update(i, { keepClipAudio: e.target.checked })} />
                    Keep the clips&apos; own sound
                  </label>
                </div>
              </div>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Select value={s.aspectRatio} onChange={(e) => update(i, { aspectRatio: e.target.value })} aria-label={`Step ${i + 1} aspect ratio`}>
                  <option value="">Aspect ratio: provider default</option>
                  {/* A ratio saved earlier that is not in the list stays selectable. */}
                  {s.aspectRatio && !(ASPECT_RATIOS as readonly string[]).includes(s.aspectRatio) && (
                    <option value={s.aspectRatio}>{s.aspectRatio}</option>
                  )}
                  {ASPECT_RATIOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                {s.kind === "video" && (
                  <Input
                    type="number"
                    min={1}
                    max={MAX_VIDEO_SECONDS}
                    step={1}
                    value={s.durationSeconds}
                    onChange={(e) => update(i, { durationSeconds: e.target.value })}
                    placeholder="Seconds (provider default)"
                    aria-label={`Step ${i + 1} length in seconds`}
                  />
                )}
                <Input
                  value={s.resolution}
                  onChange={(e) => update(i, { resolution: e.target.value })}
                  placeholder={s.kind === "video" ? "Resolution (e.g. 720p)" : "Resolution (e.g. 2K)"}
                  aria-label={`Step ${i + 1} resolution`}
                  maxLength={8}
                />
                {s.kind === "video" && (
                  <Select
                    value={s.imageFrom}
                    onChange={(e) => update(i, { imageFrom: e.target.value })}
                    aria-label={`Step ${i + 1} starts from the image of step`}
                    className="sm:col-span-3"
                  >
                    <option value="">Starts from the prompt alone</option>
                    {steps.map((other, j) =>
                      j < i && other.kind === "image" ? (
                        <option key={j} value={String(j + 1)}>
                          Starts from the image of step {j + 1}
                          {other.title.trim() ? ` (${other.title.trim()})` : ""}
                        </option>
                      ) : null,
                    )}
                    {/* A reference that no longer fits stays visible, so that it can be changed. */}
                    {s.imageFrom && !(Number(s.imageFrom) <= i && steps[Number(s.imageFrom) - 1]?.kind === "image") && (
                      <option value={s.imageFrom}>Step {s.imageFrom} (not an image step before this one)</option>
                    )}
                  </Select>
                )}
              </div>
            )}
            <Input
              value={s.acceptanceCriteria}
              onChange={(e) => update(i, { acceptanceCriteria: e.target.value })}
              placeholder="Acceptance criteria (optional)"
              aria-label={`Step ${i + 1} acceptance criteria`}
              className="mt-2"
            />
          </div>
        ))}
        <Button type="button" variant="ghost" onClick={() => setSteps((s) => [...s, { ...emptyStep }])}>
          <Icon name="plus" /> Add step
        </Button>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>{editing ? "Save workflow" : "Create workflow"}</Button>
      </div>
    </form>
  );
}

/** What the template, with these options, asks of a project. */
function ReelNeeds({ options }: { options: Parameters<typeof reelWorkflowTemplate>[0] }) {
  const needs = templateNeeds(reelWorkflowTemplate(options).steps);
  return (
    <p className="text-xs text-ink-3" data-testid="reel-needs">
      {needs.tasks} steps, {needs.media} generated {needs.media === 1 ? "file" : "files"} per run.{" "}
      {needsInWords(needs)} A project that runs it needs a task limit of at least {needs.tasks} and a media limit
      of at least {needs.media}; the project form sets both when the workflow is chosen.
    </p>
  );
}

const STEPS_SHOWN = 6;

export function WorkflowsManager({ initialWorkflows, isAdmin }: { initialWorkflows: WorkflowDTO[]; isAdmin: boolean }) {
  const [list, setList] = useState(initialWorkflows);
  const [form, setForm] = useState<{ mode: "new" | "edit"; workflow?: WorkflowDTO } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  function patch(w: WorkflowDTO) {
    setList((l) => {
      const i = l.findIndex((x) => x.id === w.id);
      if (i === -1) return [...l, w];
      const n = [...l];
      n[i] = w;
      return n;
    });
  }
  async function remove(w: WorkflowDTO) {
    if (!confirm(`Delete workflow "${w.name}"?`)) return;
    setBusy((b) => ({ ...b, [w.id]: true }));
    try {
      await apiFetch(`/api/workflows/${w.id}`, { method: "DELETE" });
      setList((l) => l.filter((x) => x.id !== w.id));
    } catch {
      setBusy((b) => ({ ...b, [w.id]: false }));
    }
  }

  return (
    <div>
      <PageHeader
        title="Workflows"
        description={
          isAdmin
            ? "Reusable, deterministic task plans. A project can run a workflow instead of AI-Manager planning."
            : "Ready-made plans. Choose one for a project on the Projects page, and its steps are worked through in order."
        }
        actions={isAdmin && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> New workflow</Button> : undefined}
      />
      {form && (
        <div className="mb-6">
          <Card title={form.mode === "new" ? "New workflow" : `Edit ${form.workflow?.name}`}>
            {/* The key gives each workflow its own form state. */}
            <Builder
              key={form.workflow?.id ?? "new"}
              initial={form.workflow}
              onSaved={(w) => { patch(w); setForm(null); }}
              onCancel={() => setForm(null)}
            />
          </Card>
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description={
            isAdmin
              ? "Build a step-based workflow to run projects deterministically, or start from the Reel template."
              : "An administrator has not made one yet. A project works without: the AI Manager plans it."
          }
        />
      ) : (
        <div className="space-y-3">
          {list.map((w) => {
            const counts = mediaCounts(w.steps);
            return (
              <Card key={w.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{w.name}</span>
                      <Badge tone="neutral">{w.steps.length} steps</Badge>
                      {counts && <Badge tone="signal">{counts}</Badge>}
                    </div>
                    {w.description && <p className="mt-0.5 text-xs text-ink-3">{w.description}</p>}
                    <ol className="mt-2 list-inside list-decimal text-xs text-ink-3">
                      {w.steps.slice(0, STEPS_SHOWN).map((s, i) => (
                        <li key={i}>
                          <span className="text-ink-2">{s.title}</span>
                          {s.kind === "render" ? "" : ` · ${s.role}`}
                          {s.kind && s.kind !== "text" ? ` · ${KIND_NOUN[s.kind]}` : ""}
                        </li>
                      ))}
                    </ol>
                    {w.steps.length > STEPS_SHOWN && (
                      <p className="mt-1 text-xs text-ink-3">and {w.steps.length - STEPS_SHOWN} more</p>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" onClick={() => setForm({ mode: "edit", workflow: w })}>Edit</Button>
                      <Button variant="danger" loading={busy[w.id]} onClick={() => remove(w)}><Icon name="trash" /></Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
