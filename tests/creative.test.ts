import assert from "node:assert/strict";
import { test } from "node:test";
import { isMediaOnly } from "../src/lib/capabilities";
import { cleanMediaPrompt, mediaArtifact, parseMediaOptions } from "../src/lib/creative/prompt";
import { reelWorkflowTemplate } from "../src/lib/creative/templates";
import {
  MAX_DEPENDENCY_CHARS,
  countMediaTasks,
  dependencyContext,
  downgradeUnavailableMedia,
  parsePlan,
} from "../src/lib/orchestrator/plan";

// ─── Which models can chat ───────────────────────────────────────────────────

test("isMediaOnly is true only for models that cannot chat", () => {
  assert.equal(isMediaOnly(["image_generation"]), true);
  assert.equal(isMediaOnly(["video_generation"]), true);
  assert.equal(isMediaOnly(["image_generation", "video_generation", "streaming"]), true);
  // A model that does both stays available for chat.
  assert.equal(isMediaOnly(["text", "image_generation"]), false);
  assert.equal(isMediaOnly(["text", "vision", "streaming"]), false);
  // Discovery imports models without capabilities; they are chat models.
  assert.equal(isMediaOnly([]), false);
});

// ─── Plans with media tasks ──────────────────────────────────────────────────

test("parsePlan defaults a task to text", () => {
  const plan = parsePlan(
    JSON.stringify({ tasks: [{ seq: 1, title: "t", objective: "o", agent: "A" }] }),
  );
  assert.ok(plan.ok);
  assert.equal(plan.tasks[0]!.kind, "text");
  assert.equal(plan.tasks[0]!.media, undefined);
});

test("parsePlan keeps image / video tasks and their options", () => {
  const plan = parsePlan(
    JSON.stringify({
      tasks: [
        { seq: 1, title: "Script", objective: "o", agent: "A" },
        {
          seq: 2,
          title: "Clip",
          objective: "o",
          agent: "A",
          dependsOn: [1],
          kind: "video",
          media: { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p" },
        },
        { seq: 3, title: "Cover", objective: "o", agent: "A", kind: "image", media: { size: "1024x1536" } },
      ],
    }),
  );
  assert.ok(plan.ok);
  assert.deepEqual(plan.tasks.map((t) => t.kind), ["text", "video", "image"]);
  assert.deepEqual(plan.tasks[1]!.media, {
    aspectRatio: "9:16",
    durationSeconds: 8,
    resolution: "720p",
  });
  assert.deepEqual(plan.tasks[1]!.dependsOn, [1]);
  assert.deepEqual(plan.tasks[2]!.media, { size: "1024x1536" });
});

test("parsePlan reads a model's sloppy media fields without failing the plan", () => {
  const plan = parsePlan(
    JSON.stringify({
      tasks: [
        { seq: 1, title: "a", objective: "o", agent: "A", kind: "audio" },
        { seq: 2, title: "b", objective: "o", agent: "A", kind: null, media: "vertical" },
        {
          seq: 3,
          title: "c",
          objective: "o",
          agent: "A",
          kind: "video",
          media: { aspectRatio: "portrait", durationSeconds: "8", resolution: "720p", size: "big" },
        },
        {
          seq: 4,
          title: "d",
          objective: "o",
          agent: "A",
          kind: "video",
          media: { aspectRatio: "9:16", durationSeconds: 600 },
        },
      ],
    }),
  );
  assert.ok(plan.ok, plan.error);
  // An unknown kind is a text task.
  assert.deepEqual(plan.tasks.map((t) => t.kind), ["text", "text", "video", "video"]);
  assert.equal(plan.tasks[1]!.media, undefined);
  // Bad fields are dropped one by one; a numeric string is accepted.
  assert.deepEqual(plan.tasks[2]!.media, { durationSeconds: 8, resolution: "720p" });
  // A duration beyond the limit is dropped, not clamped.
  assert.deepEqual(plan.tasks[3]!.media, { aspectRatio: "9:16" });
});

// ─── The Reel template ───────────────────────────────────────────────────────

test("the Reel template has the documented shape", () => {
  const t = reelWorkflowTemplate();
  assert.equal(t.name, "Reel (3 scenes)");
  assert.deepEqual(
    t.steps.map((s) => [s.title, s.kind ?? "text"]),
    [
      ["Concept and script", "text"],
      ["Storyboard", "text"],
      ["Scene 1 clip", "video"],
      ["Scene 2 clip", "video"],
      ["Scene 3 clip", "video"],
      ["Cover image", "image"],
      ["Caption and hashtags", "text"],
    ],
  );
  for (const step of t.steps.filter((s) => s.kind === "video")) {
    assert.deepEqual(step.media, { aspectRatio: "9:16", durationSeconds: 8 });
    assert.deepEqual(step.dependsOn, [2]); // clips only need the storyboard, so they run in parallel
  }
  assert.deepEqual(t.steps.find((s) => s.kind === "image")!.media, { aspectRatio: "9:16" });
});

test("the Reel template only depends on earlier steps", () => {
  for (const scenes of [1, 3, 8]) {
    const t = reelWorkflowTemplate({ scenes, clipSeconds: 6 });
    assert.equal(t.steps.length, scenes + 4);
    t.steps.forEach((step, i) => {
      for (const dep of step.dependsOn ?? []) {
        assert.ok(dep >= 1 && dep < i + 1, `${step.title} depends on ${dep}`);
      }
    });
  }
});

test("the Reel template clamps its options", () => {
  assert.equal(reelWorkflowTemplate({ scenes: 0 }).steps.length, 1 + 4);
  assert.equal(reelWorkflowTemplate({ scenes: 99 }).steps.length, 8 + 4);
  assert.equal(reelWorkflowTemplate({ scenes: Number.NaN }).steps.length, 3 + 4);
  const long = reelWorkflowTemplate({ clipSeconds: 999 });
  assert.equal(long.steps.find((s) => s.kind === "video")!.media!.durationSeconds, 20);
  assert.equal(reelWorkflowTemplate({ scenes: 1 }).name, "Reel (1 scene)");
});

test("the Reel template survives the planner's own validation", () => {
  // A project runs a workflow by turning its steps into a plan (see runProject).
  const t = reelWorkflowTemplate({ scenes: 8 });
  const plan = parsePlan(
    JSON.stringify({
      tasks: t.steps.map((s, i) => ({
        seq: i + 1,
        title: s.title,
        objective: s.objective,
        acceptanceCriteria: s.acceptanceCriteria ?? "",
        agent: s.role,
        dependsOn: s.dependsOn ?? [],
        kind: s.kind,
        media: s.media,
      })),
    }),
    20,
  );
  assert.ok(plan.ok, plan.error);
  assert.equal(plan.tasks.length, 12);
  assert.equal(plan.tasks.filter((x) => x.kind === "video").length, 8);
  assert.deepEqual(plan.tasks[10]!.dependsOn, [1, 2]);
});

// ─── Prompts written by agents ───────────────────────────────────────────────

test("cleanMediaPrompt strips the wrapping models add", () => {
  assert.equal(cleanMediaPrompt("  A red fox in snow.  "), "A red fox in snow.");
  assert.equal(cleanMediaPrompt("Prompt: A red fox in snow."), "A red fox in snow.");
  assert.equal(cleanMediaPrompt("**Video prompt:** A red fox in snow."), "A red fox in snow.");
  assert.equal(cleanMediaPrompt("Image Prompt - A red fox in snow."), "A red fox in snow.");
  assert.equal(cleanMediaPrompt('"A red fox in snow."'), "A red fox in snow.");
  assert.equal(cleanMediaPrompt("“A red fox in snow.”"), "A red fox in snow.");
  assert.equal(
    cleanMediaPrompt("Here is the prompt:\n```text\nA red fox\nin snow.\n```\nHope it helps!"),
    "A red fox in snow.",
  );
});

test("cleanMediaPrompt collapses whitespace and leaves ordinary text alone", () => {
  assert.equal(cleanMediaPrompt("A red fox\n\n  in   snow,\twide shot."), "A red fox in snow, wide shot.");
  // Quotes inside the text, or a word that merely starts with 'prompt', stay.
  assert.equal(cleanMediaPrompt('A sign that says "OPEN" above a door.'), 'A sign that says "OPEN" above a door.');
  assert.equal(cleanMediaPrompt("Prompted by rain, a crowd opens umbrellas."), "Prompted by rain, a crowd opens umbrellas.");
});

test("cleanMediaPrompt cuts to the length limit", () => {
  assert.equal(cleanMediaPrompt("x".repeat(5000)).length, 4000);
  assert.equal(cleanMediaPrompt("word ".repeat(10), 12), "word word wo");
  assert.equal(cleanMediaPrompt("   "), "");
});

test("cleanMediaPrompt only removes quotes that wrap the whole prompt", () => {
  assert.equal(cleanMediaPrompt("`A red fox in snow.`"), "A red fox in snow.");
  assert.equal(cleanMediaPrompt("'A red fox in snow.'"), "A red fox in snow.");
  // Two quoted words at the ends are not a wrapper.
  assert.equal(cleanMediaPrompt('"OPEN" sign above a "door"'), '"OPEN" sign above a "door"');
  // Nor are quotes that do not match.
  assert.equal(cleanMediaPrompt("\"A red fox in snow.'"), "\"A red fox in snow.'");
  assert.equal(cleanMediaPrompt("“A red fox in snow.\""), "“A red fox in snow.\"");
  assert.equal(cleanMediaPrompt('""'), '""');
});

test("cleanMediaPrompt drops a lead-in line but not a hyphenated first word", () => {
  assert.equal(
    cleanMediaPrompt("Sure! Here is the prompt:\n\nA red fox in snow, wide shot."),
    "A red fox in snow, wide shot.",
  );
  assert.equal(cleanMediaPrompt("Here you go:\nPrompt: A red fox."), "A red fox.");
  // A colon in the middle of a single line is part of the prompt.
  assert.equal(cleanMediaPrompt("Style: watercolour. A red fox."), "Style: watercolour. A red fox.");
  assert.equal(cleanMediaPrompt("Prompt-driven neon sign glowing."), "Prompt-driven neon sign glowing.");
});

test("mediaArtifact says what was generated and that agents cannot see it", () => {
  const text = mediaArtifact({
    kind: "video",
    assetId: "a1",
    modelLabel: "grok-imagine-video-1.5",
    prompt: "A red fox in snow.",
    options: { aspectRatio: "9:16", durationSeconds: 8 },
  });
  assert.match(text, /^Generated video with grok-imagine-video-1\.5 \(9:16, 8s\)\. Asset a1\./);
  assert.match(text, /not visible to other agents/);
  assert.ok(text.endsWith("A red fox in snow."));

  const image = mediaArtifact({ kind: "image", assetId: "a2", modelLabel: "m", prompt: "p", options: { durationSeconds: 8 } });
  assert.match(image, /^Generated image with m\. Asset a2\./); // a duration means nothing for an image
});

test("parseMediaOptions never throws and keeps only known fields", () => {
  assert.deepEqual(parseMediaOptions(null), {});
  assert.deepEqual(parseMediaOptions("not json"), {});
  assert.deepEqual(parseMediaOptions("[1,2]"), {});
  assert.deepEqual(
    parseMediaOptions(JSON.stringify({ aspectRatio: "9:16", durationSeconds: 8, resolution: "720p", size: "720x1280", other: 1 })),
    { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p", size: "720x1280" },
  );
  assert.deepEqual(parseMediaOptions(JSON.stringify({ durationSeconds: -1, aspectRatio: 5 })), {});
});

// ─── What a run does with media tasks ────────────────────────────────────────

test("countMediaTasks counts what a plan would generate", () => {
  assert.deepEqual(countMediaTasks([]), { image: 0, video: 0 });
  assert.deepEqual(
    countMediaTasks([{ kind: "text" }, { kind: "video" }, { kind: "image" }, { kind: "video" }]),
    { image: 1, video: 2 },
  );
  // The Reel template: one clip per scene and one cover.
  const reel = reelWorkflowTemplate({ scenes: 4 }).steps.map((s) => ({ kind: s.kind ?? ("text" as const) }));
  assert.deepEqual(countMediaTasks(reel), { image: 1, video: 4 });
});

test("downgradeUnavailableMedia turns media tasks without a model into text tasks", () => {
  const tasks = [
    { seq: 1, kind: "text" as const, title: "script" },
    { seq: 2, kind: "image" as const, title: "cover", media: { aspectRatio: "9:16" } },
    { seq: 3, kind: "video" as const, title: "clip", media: { durationSeconds: 8 } },
  ];

  const both = downgradeUnavailableMedia(tasks, { image: true, video: true });
  assert.deepEqual(both.downgraded, []);
  assert.deepEqual(both.tasks, tasks);

  const imagesOnly = downgradeUnavailableMedia(tasks, { image: true, video: false });
  assert.deepEqual(imagesOnly.downgraded, [3]);
  assert.deepEqual(imagesOnly.tasks.map((t) => t.kind), ["text", "image", "text"]);
  // The options of a task that no longer generates anything are dropped.
  assert.equal((imagesOnly.tasks[2] as { media?: unknown }).media, undefined);
  assert.deepEqual((imagesOnly.tasks[1] as { media?: unknown }).media, { aspectRatio: "9:16" });

  const none = downgradeUnavailableMedia(tasks, { image: false, video: false });
  assert.deepEqual(none.downgraded, [2, 3]);
  assert.deepEqual(countMediaTasks(none.tasks), { image: 0, video: 0 });
  // The input is not changed.
  assert.equal(tasks[1]!.kind, "image");
});

test("dependencyContext hands a task the outputs it depends on", () => {
  const outputs = new Map([
    [1, { title: "Script", artifact: "Scene 1: a lighthouse." }],
    [2, { title: "Storyboard", artifact: "Style: warm dusk light." }],
    [3, { title: "Failed task", artifact: null }],
  ]);
  const lookup = (seq: number) => outputs.get(seq);

  assert.equal(dependencyContext([], lookup), "");
  assert.equal(
    dependencyContext([1, 2], lookup),
    "### Output of task 1 (Script)\nScene 1: a lighthouse.\n\n### Output of task 2 (Storyboard)\nStyle: warm dusk light.",
  );
  // A dependency without an output, or one that does not exist, adds nothing.
  assert.equal(dependencyContext([3, 9], lookup), "");
  assert.equal(dependencyContext([3, 2], lookup), "### Output of task 2 (Storyboard)\nStyle: warm dusk light.");
});

test("dependencyContext cuts a very long output and says so", () => {
  const long = "x".repeat(MAX_DEPENDENCY_CHARS + 500);
  const text = dependencyContext([1], () => ({ title: "Long", artifact: long }));
  assert.ok(text.includes("x".repeat(MAX_DEPENDENCY_CHARS)));
  assert.ok(!text.includes("x".repeat(MAX_DEPENDENCY_CHARS + 1)));
  assert.ok(text.endsWith("… (cut: the full output is longer)"));

  // Exactly at the limit nothing is cut.
  const exact = dependencyContext([1], () => ({ title: "Exact", artifact: "y".repeat(50) }), 50);
  assert.equal(exact, `### Output of task 1 (Exact)\n${"y".repeat(50)}`);
});

test("downgradeUnavailableMedia keeps only as many media tasks as the run may generate", () => {
  const tasks = [
    { seq: 1, kind: "image" as const },
    { seq: 2, kind: "text" as const },
    { seq: 3, kind: "video" as const },
    { seq: 4, kind: "image" as const },
    { seq: 5, kind: "video" as const },
  ];
  const all = { image: true, video: true };

  // The first ones in task order are kept, whatever their kind.
  const two = downgradeUnavailableMedia(tasks, all, 2);
  assert.deepEqual(two.downgraded, [4, 5]);
  assert.deepEqual(two.tasks.map((t) => t.kind), ["image", "text", "video", "text", "text"]);

  // A limit of zero turns media off.
  const zero = downgradeUnavailableMedia(tasks, all, 0);
  assert.deepEqual(zero.downgraded, [1, 3, 4, 5]);
  assert.deepEqual(countMediaTasks(zero.tasks), { image: 0, video: 0 });

  // A task without a model does not use up the limit.
  const imagesOnly = downgradeUnavailableMedia(tasks, { image: true, video: false }, 2);
  assert.deepEqual(imagesOnly.downgraded, [3, 5]);
  assert.deepEqual(imagesOnly.tasks.map((t) => t.kind), ["image", "text", "text", "image", "text"]);

  // Enough room: nothing changes.
  assert.deepEqual(downgradeUnavailableMedia(tasks, all, 4).downgraded, []);
  assert.deepEqual(downgradeUnavailableMedia(tasks, all).downgraded, []);
});
