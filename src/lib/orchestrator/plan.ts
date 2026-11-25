import { z } from "zod";
import {
  ASPECT_RATIO_PATTERN,
  MAX_VIDEO_SECONDS,
  RESOLUTION_PATTERN,
  SIZE_PATTERN,
} from "../adapters/media-protocol";
import {
  MAX_SPEECH_SPEED,
  MIN_SPEECH_SPEED,
  TASK_KINDS,
  VOICE_PATTERN,
  type MediaOptions,
  type TaskKind,
} from "../creative/prompt";

/**
 * Plan parsing for the AI Manager. Pure + dependency-free so it can be
 * unit-tested without a model or the database.
 */

export { TASK_KINDS };

/**
 * Options of a creative task. A plan is written by a model, so each field is
 * read leniently: a value that does not fit is dropped rather than failing
 * the whole plan.
 */
export const plannedMediaSchema = z
  .object({
    aspectRatio: z.string().regex(ASPECT_RATIO_PATTERN).optional().catch(undefined),
    durationSeconds: z.coerce.number().int().min(1).max(MAX_VIDEO_SECONDS).optional().catch(undefined),
    resolution: z.string().regex(RESOLUTION_PATTERN).optional().catch(undefined),
    size: z.string().regex(SIZE_PATTERN).optional().catch(undefined),
    voice: z.string().regex(VOICE_PATTERN).optional().catch(undefined),
    speed: z.coerce.number().min(MIN_SPEECH_SPEED).max(MAX_SPEECH_SPEED).optional().catch(undefined),
    imageFrom: z.coerce.number().int().positive().optional().catch(undefined),
    subtitles: z.boolean().optional().catch(undefined),
    keepClipAudio: z.boolean().optional().catch(undefined),
    fit: z.enum(["contain", "cover"]).optional().catch(undefined),
  })
  .transform((media) => {
    // Leave out the fields that were dropped, instead of keeping them as undefined.
    const out: MediaOptions = {};
    if (media.aspectRatio !== undefined) out.aspectRatio = media.aspectRatio;
    if (media.durationSeconds !== undefined) out.durationSeconds = media.durationSeconds;
    if (media.resolution !== undefined) out.resolution = media.resolution;
    if (media.size !== undefined) out.size = media.size;
    if (media.voice !== undefined) out.voice = media.voice;
    if (media.speed !== undefined) out.speed = media.speed;
    if (media.imageFrom !== undefined) out.imageFrom = media.imageFrom;
    if (media.subtitles !== undefined) out.subtitles = media.subtitles;
    if (media.keepClipAudio !== undefined) out.keepClipAudio = media.keepClipAudio;
    if (media.fit !== undefined) out.fit = media.fit;
    return out;
  });

export const plannedTaskSchema = z.object({
  seq: z.number().int().positive(),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4000),
  acceptanceCriteria: z.string().max(2000).optional().default(""),
  agent: z.string().min(1).max(120),
  dependsOn: z.array(z.number().int().positive()).max(20).optional().default([]),
  // Optional: save this task's artifact to the workspace at this relative path.
  outputFile: z.string().max(256).optional(),
  // What the task delivers. Anything that is not one of the kinds is text.
  kind: z.enum(TASK_KINDS).catch("text"),
  media: plannedMediaSchema.optional().catch(undefined),
});

export const planSchema = z.object({
  tasks: z.array(plannedTaskSchema).min(1).max(80),
});

export type PlannedTask = z.infer<typeof plannedTaskSchema>;

/** Extract the first balanced JSON object from a model response. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface ParsedPlan {
  ok: boolean;
  tasks: PlannedTask[];
  error?: string;
}

/** Parse + validate a manager plan, capping task count. */
export function parsePlan(raw: string, maxTasks = 12): ParsedPlan {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, tasks: [], error: "No JSON object found in plan" };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, tasks: [], error: "Plan was not valid JSON" };
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, tasks: [], error: parsed.error.issues[0]?.message ?? "Invalid plan" };
  }
  // Normalize: renumber seq to 1..n by given order, remap dependencies onto the
  // new numbering, and keep only dependencies on strictly-earlier tasks.
  const sorted = parsed.data.tasks.slice(0, maxTasks);
  const remap = new Map<number, number>();
  sorted.forEach((t, i) => remap.set(t.seq, i + 1));
  const kindOf = new Map(sorted.map((t, i) => [i + 1, t.kind] as const));
  const tasks = sorted.map((t, i) => {
    const newSeq = i + 1;
    const deps = new Set(
      (t.dependsOn ?? [])
        .map((d) => remap.get(d))
        .filter((d): d is number => typeof d === "number" && d < newSeq),
    );
    // The picture a video starts from: an earlier image task, which the video
    // then also depends on. Anything else is dropped, and the clip is
    // generated from its prompt alone.
    let media = t.media;
    if (media?.imageFrom !== undefined) {
      const from = remap.get(media.imageFrom);
      if (t.kind === "video" && from !== undefined && from < newSeq && kindOf.get(from) === "image") {
        media = { ...media, imageFrom: from };
        deps.add(from);
      } else {
        const { imageFrom: _dropped, ...rest } = media;
        media = rest;
      }
    }
    return { ...t, seq: newSeq, dependsOn: [...deps].sort((a, b) => a - b), media };
  });
  return { ok: true, tasks };
}

export type Verdict = "pass" | "concerns" | "fail";

/** Extract a reviewer verdict line ("VERDICT: pass|concerns|fail"). */
export function parseVerdict(text: string): Verdict | null {
  const m = text.match(/VERDICT:\s*(pass|concerns|fail)/i);
  return m ? (m[1]!.toLowerCase() as Verdict) : null;
}

/**
 * Could the failure of an agent's first request be about its tools? A model
 * that takes none refuses the request (400, 404, 422). A provider that is
 * limited, busy, broken or out of reach says nothing about tools: asking the
 * same model again without them would take the agent's tools away for
 * nothing, so the agent's next model is asked instead.
 */
export function mayBeAboutTools(error: { code?: string; message: string }): boolean {
  // A name that no address was found for (dns_error) is out of reach as well: nothing was asked.
  if (error.code === "timeout" || error.code === "network_error" || error.code === "dns_error") return false;
  const status = Number(/^Provider responded (\d{3})\b/.exec(error.message)?.[1] ?? 0);
  return !(status === 408 || status === 429 || status >= 500);
}

/** Topological order of task seqs (Kahn); falls back to seq order on a cycle. */
export function topoOrder(tasks: { seq: number; dependsOn: number[] }[]): number[] {
  const indeg = new Map<number, number>();
  const edges = new Map<number, number[]>();
  for (const t of tasks) {
    indeg.set(t.seq, 0);
    edges.set(t.seq, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!indeg.has(d)) continue;
      edges.get(d)!.push(t.seq);
      indeg.set(t.seq, (indeg.get(t.seq) ?? 0) + 1);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([s]) => s).sort((a, b) => a - b);
  const order: number[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of edges.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 1) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
    queue.sort((a, b) => a - b);
  }
  if (order.length !== tasks.length) {
    return tasks.map((t) => t.seq).sort((a, b) => a - b); // cycle: fall back
  }
  return order;
}

// ─── Creative tasks ──────────────────────────────────────────────────────────

/**
 * What a project can make besides text: it needs a model for images, videos
 * and voice-overs, and ffmpeg on the server to join clips.
 */
export interface MediaAvailability {
  image: boolean;
  video: boolean;
  audio: boolean;
  render: boolean;
}

/**
 * Turn the creative tasks a run cannot do into text tasks, so the agent still
 * writes something useful instead of the task failing: tasks of a kind the
 * project has no model for, and tasks beyond `limit`, the number of images,
 * videos and voice-overs one run may generate (counted in task order). Joining
 * clips costs nothing at a provider and does not count.
 * Returns the adjusted tasks and the seqs that were changed.
 */
export function downgradeUnavailableMedia<T extends { seq: number; kind: TaskKind }>(
  tasks: T[],
  available: MediaAvailability,
  limit: number = Number.POSITIVE_INFINITY,
): { tasks: T[]; downgraded: number[] } {
  const downgraded: number[] = [];
  let kept = 0;
  const out = tasks.map((t) => {
    if (t.kind === "text") return t;
    if (t.kind === "render") {
      if (available.render) return t;
    } else if (available[t.kind] && kept < limit) {
      kept++;
      return t;
    }
    downgraded.push(t.seq);
    return { ...t, kind: "text" as TaskKind, media: undefined };
  });
  return { tasks: out, downgraded };
}

/** How many tasks of each creative kind a plan has. */
export function countMediaTasks(tasks: { kind: TaskKind }[]): {
  image: number;
  video: number;
  audio: number;
  render: number;
} {
  const count = (kind: TaskKind) => tasks.filter((t) => t.kind === kind).length;
  return { image: count("image"), video: count("video"), audio: count("audio"), render: count("render") };
}

/**
 * What a render task joins: the videos among the tasks it depends on, in task
 * order, or their images when there is no video, and the voice-overs among
 * them. A render task without dependencies takes every earlier task.
 */
export function renderInputs(
  task: { seq: number; dependsOn: number[] },
  all: { seq: number; kind: TaskKind }[],
): { clips: number[]; voiceOvers: number[] } {
  const earlier = all.filter((t) => t.seq < task.seq).sort((a, b) => a.seq - b.seq);
  const pool = task.dependsOn.length > 0 ? earlier.filter((t) => task.dependsOn.includes(t.seq)) : earlier;
  const of = (kind: TaskKind) => pool.filter((t) => t.kind === kind).map((t) => t.seq);
  const videos = of("video");
  return { clips: videos.length > 0 ? videos : of("image"), voiceOvers: of("audio") };
}

/** Longest piece of one earlier task's output handed to a later task. */
export const MAX_DEPENDENCY_CHARS = 12_000;

/**
 * The outputs of the tasks a task depends on, as one block of text for its
 * prompt. `outputOf` returns the finished output of a task, or nothing when
 * that task has none.
 */
export function dependencyContext(
  dependsOn: number[],
  outputOf: (seq: number) => { title: string; artifact: string | null | undefined } | undefined,
  maxChars: number = MAX_DEPENDENCY_CHARS,
): string {
  return dependsOn
    .map((seq) => {
      const dep = outputOf(seq);
      if (!dep?.artifact) return "";
      const text =
        dep.artifact.length > maxChars
          ? `${dep.artifact.slice(0, maxChars)}\n… (cut: the full output is longer)`
          : dep.artifact;
      return `### Output of task ${seq} (${dep.title})\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}
