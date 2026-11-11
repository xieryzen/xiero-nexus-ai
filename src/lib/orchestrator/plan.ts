import { z } from "zod";

/**
 * Plan parsing for the AI Manager. Pure + dependency-free so it can be
 * unit-tested without a model or the database.
 */

export const plannedTaskSchema = z.object({
  seq: z.number().int().positive(),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4000),
  acceptanceCriteria: z.string().max(2000).optional().default(""),
  agent: z.string().min(1).max(120),
  dependsOn: z.array(z.number().int().positive()).max(20).optional().default([]),
  // Optional: save this task's artifact to the workspace at this relative path.
  outputFile: z.string().max(256).optional(),
});

export const planSchema = z.object({
  tasks: z.array(plannedTaskSchema).min(1).max(50),
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
  const tasks = sorted.map((t, i) => {
    const newSeq = i + 1;
    const deps = [
      ...new Set(
        (t.dependsOn ?? [])
          .map((d) => remap.get(d))
          .filter((d): d is number => typeof d === "number" && d < newSeq),
      ),
    ];
    return { ...t, seq: newSeq, dependsOn: deps };
  });
  return { ok: true, tasks };
}

export type Verdict = "pass" | "concerns" | "fail";

/** Extract a reviewer verdict line ("VERDICT: pass|concerns|fail"). */
export function parseVerdict(text: string): Verdict | null {
  const m = text.match(/VERDICT:\s*(pass|concerns|fail)/i);
  return m ? (m[1]!.toLowerCase() as Verdict) : null;
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
