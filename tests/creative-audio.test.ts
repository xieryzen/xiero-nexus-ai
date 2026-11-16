import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVideoRequest } from "../src/lib/adapters/media-protocol";
import { CAPABILITIES, MEDIA_CAPABILITY, isMediaOnly } from "../src/lib/capabilities";
import {
  GENERATED_KINDS,
  MAX_SPEECH_CHARS,
  TASK_KINDS,
  VOICE_PATTERN,
  cleanSpeechText,
  isGeneratedKind,
  mediaArtifact,
  parseMediaOptions,
  renderArtifact,
} from "../src/lib/creative/prompt";
import { REEL_MAX_SCENES, needsInWords, reelWorkflowTemplate, templateNeeds } from "../src/lib/creative/templates";
import { capabilitiesForType, guessModelType, suggestModel, typeOfCapabilities } from "../src/lib/discovery";
import { sanitizeUpstreamError } from "../src/lib/errors";
import { countMediaTasks, downgradeUnavailableMedia, parsePlan, plannedMediaSchema, renderInputs } from "../src/lib/orchestrator/plan";

// ─── Kinds of models and tasks ───────────────────────────────────────────────

test("speech and embedding models are no chat models either", () => {
  assert.equal(isMediaOnly(["speech_generation"]), true);
  assert.equal(isMediaOnly(["embeddings"]), true);
  assert.equal(isMediaOnly(["embeddings", "streaming"]), true);
  assert.equal(isMediaOnly(["text", "embeddings"]), false);
  assert.equal(isMediaOnly(["text", "audio"]), false);
  assert.equal(MEDIA_CAPABILITY.audio, "speech_generation");
  assert.ok(CAPABILITIES.includes("speech_generation"));
  assert.deepEqual([...TASK_KINDS], ["text", "image", "video", "audio", "render"]);
  assert.deepEqual([...GENERATED_KINDS], ["image", "video", "audio"]);
  // Joining clips generates nothing at a provider.
  assert.equal(isGeneratedKind("render"), false);
  assert.equal(isGeneratedKind("audio"), true);
});

// ─── What a voice speaks ─────────────────────────────────────────────────────

test("an agent's reply becomes the words to speak, without what a voice would read by mistake", () => {
  assert.equal(cleanSpeechText('**Voice-over:** "Welcome to the lighthouse. This is scene one."\n\n(pause)'), "Welcome to the lighthouse. This is scene one.");
  assert.equal(cleanSpeechText("Here is the script:\n\nThe keeper climbs the stairs.\nEvery night."), "The keeper climbs the stairs. Every night.");
  assert.equal(cleanSpeechText("```\nNarrator: The sea is calm.\n```"), "The sea is calm.");
  assert.equal(cleanSpeechText("# Scene 1\n- The *lamp* turns.\n[music fades]\n> And `again`."), "Scene 1 The lamp turns. And again.");
  assert.equal(cleanSpeechText("Scene 2: The storm arrives."), "The storm arrives.");
  // Quotes inside the text are part of it.
  assert.equal(cleanSpeechText('She said "go" and "stay".'), 'She said "go" and "stay".');
  assert.equal(cleanSpeechText("   \n (silence) \n"), "");
});

test("text over the limit ends on a whole sentence where that keeps most of it", () => {
  const sentence = "This sentence is exactly forty characters. ";
  const long = sentence.repeat(200);
  const cut = cleanSpeechText(long);
  assert.ok(cut.length <= MAX_SPEECH_CHARS);
  assert.ok(cut.length > MAX_SPEECH_CHARS * 0.9);
  assert.ok(cut.endsWith("characters."));
  // Without a sentence end to stop at, it is cut at the limit.
  assert.equal(cleanSpeechText("x".repeat(5000)).length, MAX_SPEECH_CHARS);
  assert.equal(cleanSpeechText("One. Two. Three.", 9), "One. Two.");
});

test("a voice is the provider's name for it", () => {
  for (const ok of ["alloy", "Kore", "en-US-Neural2-F", "nova 2", "id:21m00Tcm4TlvDq8ikWAM", "Zoë"]) assert.ok(VOICE_PATTERN.test(ok), ok);
  for (const bad of ["", " alloy", "a/b", "x".repeat(65), "voice\nname", "<alloy>"]) assert.ok(!VOICE_PATTERN.test(bad), bad);
});

// ─── Options and artifacts ───────────────────────────────────────────────────

test("stored options keep the fields of every kind, and nothing else", () => {
  assert.deepEqual(
    parseMediaOptions(JSON.stringify({ voice: "alloy", speed: 1.25, imageFrom: 3, imageAssetId: "abc", subtitles: false, keepClipAudio: true, fit: "cover", other: 1 })),
    { voice: "alloy", speed: 1.25, imageFrom: 3, imageAssetId: "abc", subtitles: false, keepClipAudio: true, fit: "cover" },
  );
  assert.deepEqual(parseMediaOptions(JSON.stringify({ voice: "", speed: 0, imageFrom: 1.5, fit: "stretch", subtitles: "yes" })), {});
});

test("a plan's creative options are read leniently, field by field", () => {
  assert.deepEqual(plannedMediaSchema.parse({ voice: "alloy", speed: "1.5", imageFrom: "2", subtitles: true, fit: "cover", keepClipAudio: false }), {
    voice: "alloy",
    speed: 1.5,
    imageFrom: 2,
    subtitles: true,
    keepClipAudio: false,
    fit: "cover",
  });
  assert.deepEqual(plannedMediaSchema.parse({ voice: "bad/voice", speed: 9, imageFrom: -1, subtitles: "yes", fit: "stretch", aspectRatio: "9:16" }), { aspectRatio: "9:16" });
});

test("what a creative task leaves behind says what was generated, and that nobody saw or heard it", () => {
  const audio = mediaArtifact({ kind: "audio", assetId: "a1", modelLabel: "tts-1", prompt: "Hello there.", options: { voice: "alloy" } });
  assert.equal(audio, "Generated voice-over with tts-1 (voice alloy). Asset a1.\nThe audio itself is not audible to other agents; this is the text that is spoken:\nHello there.");
  const video = mediaArtifact({ kind: "video", assetId: "v1", modelLabel: "vid", prompt: "Waves.", options: { aspectRatio: "9:16", durationSeconds: 8, imageAssetId: "img1" } });
  assert.match(video, /^Generated video with vid \(9:16, 8s, starting from an image\)\. Asset v1\./);
  assert.equal(
    renderArtifact({ assetId: "r1", clips: 3, voiceOvers: 3, subtitles: true, durationSeconds: 24.2 }).split("\n")[0],
    "Joined video from 3 clips, with voice-over and subtitles (24s). Asset r1.",
  );
  assert.equal(renderArtifact({ assetId: "r1", clips: 1, voiceOvers: 0, subtitles: true, durationSeconds: null }).split("\n")[0], "Joined video from 1 clip. Asset r1.");
  assert.equal(renderArtifact({ assetId: "r1", clips: 2, voiceOvers: 1, subtitles: false, durationSeconds: 4 }).split("\n")[0], "Joined video from 2 clips, with voice-over (4s). Asset r1.");
});

// ─── Image-to-video on the wire ──────────────────────────────────────────────

test("the picture a video starts from is sent the way each style takes it", () => {
  const image = "data:image/png;base64,AAAA";
  const base = { model: "v", prompt: "it comes to life", image };
  assert.deepEqual(buildVideoRequest("openai", base).body.input_reference, { image_url: image });
  assert.deepEqual(buildVideoRequest("openrouter", base).body.frame_images, [{ type: "image_url", image_url: { url: image }, frame_type: "first_frame" }]);
  assert.deepEqual(buildVideoRequest("xai", base).body.image, { url: image });
  // Without a picture none of these fields is sent.
  for (const api of ["openai", "openrouter", "xai"] as const) {
    const body = buildVideoRequest(api, { model: "v", prompt: "p" }).body;
    assert.deepEqual([body.input_reference, body.frame_images, body.image], [undefined, undefined, undefined], api);
  }
});

// ─── Plans ───────────────────────────────────────────────────────────────────

const task = (seq: number, kind: string, extra: Record<string, unknown> = {}) => ({ seq, title: `t${seq}`, objective: "o", agent: "A", kind, ...extra });

test("a clip that starts from an image depends on that image task; a reference that does not fit is dropped", () => {
  const plan = parsePlan(
    JSON.stringify({
      tasks: [
        task(10, "image"),
        task(20, "video", { media: { imageFrom: 10, durationSeconds: 5 } }),
        task(30, "video", { media: { imageFrom: 40 } }), // a later task
        task(40, "text"),
        task(50, "video", { media: { imageFrom: 40 }, dependsOn: [40] }), // not an image task
        task(60, "image", { media: { imageFrom: 10 } }), // only a video starts from an image
      ],
    }),
  );
  assert.ok(plan.ok, plan.error);
  assert.deepEqual(plan.tasks.map((t) => [t.seq, t.dependsOn, t.media ?? null]), [
    [1, [], null],
    // Renumbered with the tasks, and added to what the clip depends on.
    [2, [1], { imageFrom: 1, durationSeconds: 5 }],
    [3, [], {}],
    [4, [], null],
    [5, [4], {}],
    [6, [], {}],
  ]);
});

test("a render task joins the videos it depends on, or their images, with their voice-overs", () => {
  const all = [
    { seq: 1, kind: "text" as const },
    { seq: 2, kind: "image" as const },
    { seq: 3, kind: "video" as const },
    { seq: 4, kind: "audio" as const },
    { seq: 5, kind: "video" as const },
    { seq: 6, kind: "audio" as const },
    { seq: 7, kind: "render" as const },
    { seq: 8, kind: "video" as const },
  ];
  assert.deepEqual(renderInputs({ seq: 7, dependsOn: [5, 3, 6, 4] }, all), { clips: [3, 5], voiceOvers: [4, 6] });
  assert.deepEqual(renderInputs({ seq: 7, dependsOn: [5] }, all), { clips: [5], voiceOvers: [] });
  // Without dependencies it takes every earlier task, and nothing that comes after it.
  assert.deepEqual(renderInputs({ seq: 7, dependsOn: [] }, all), { clips: [3, 5], voiceOvers: [4, 6] });
  // No video among them: the images are the clips.
  assert.deepEqual(renderInputs({ seq: 7, dependsOn: [2, 4] }, all), { clips: [2], voiceOvers: [4] });
  assert.deepEqual(renderInputs({ seq: 2, dependsOn: [] }, all), { clips: [], voiceOvers: [] });
});

test("voice-overs count against the media limit; joining does not, and needs ffmpeg instead of a model", () => {
  const tasks = [
    { seq: 1, kind: "audio" as const },
    { seq: 2, kind: "video" as const },
    { seq: 3, kind: "render" as const },
    { seq: 4, kind: "audio" as const },
  ];
  const all = { image: true, video: true, audio: true, render: true };
  assert.deepEqual(downgradeUnavailableMedia(tasks, all, 2).tasks.map((t) => t.kind), ["audio", "video", "render", "text"]);
  assert.deepEqual(downgradeUnavailableMedia(tasks, { ...all, audio: false }).tasks.map((t) => t.kind), ["text", "video", "render", "text"]);
  assert.deepEqual(downgradeUnavailableMedia(tasks, { ...all, render: false }).downgraded, [3]);
  assert.deepEqual(countMediaTasks(tasks), { image: 0, video: 1, audio: 2, render: 1 });
});

// ─── The Reel template ───────────────────────────────────────────────────────

test("without options the Reel template is what it was", () => {
  const plain = reelWorkflowTemplate({ scenes: 2, clipSeconds: 6 });
  assert.equal(plain.name, "Reel (2 scenes)");
  assert.deepEqual(plain.steps.map((s) => s.kind ?? "text"), ["text", "text", "video", "video", "image", "text"]);
  assert.deepEqual(plain.steps[2]!.media, { aspectRatio: "9:16", durationSeconds: 6 });
  // The description says what the workflow makes: everyone who may choose it reads it.
  assert.equal(plain.description, "Script, storyboard, 2 vertical scenes of 6 s, a cover image and a caption.");
  assert.equal(needsInWords(templateNeeds(plain.steps)), "The project needs a video model and an image model.");
});

test("keyframes, voice-over and the final cut each add their steps, in an order a plan accepts", () => {
  const full = reelWorkflowTemplate({ scenes: 2, clipSeconds: 5, keyframes: true, voiceOver: true, voice: " alloy ", join: true, subtitles: true });
  assert.equal(full.name, "Reel (2 scenes, keyframes, voice-over, joined, subtitles)");
  assert.deepEqual(
    full.steps.map((s) => [s.title, s.kind ?? "text", s.dependsOn ?? []]),
    [
      ["Concept and script", "text", []],
      ["Storyboard", "text", [1]],
      ["Scene 1 keyframe", "image", [2]],
      ["Scene 1 clip", "video", [2, 3]],
      ["Scene 1 voice-over", "audio", [1]],
      ["Scene 2 keyframe", "image", [2]],
      ["Scene 2 clip", "video", [2, 6]],
      ["Scene 2 voice-over", "audio", [1]],
      ["Final cut", "render", [4, 7, 5, 8]],
      ["Cover image", "image", [1, 2]],
      ["Caption and hashtags", "text", [1]],
    ],
  );
  assert.deepEqual(full.steps[3]!.media, { aspectRatio: "9:16", durationSeconds: 5, imageFrom: 3 });
  assert.deepEqual(full.steps[4]!.media, { durationSeconds: 5, voice: "alloy" });
  assert.deepEqual(full.steps[8]!.media, { aspectRatio: "9:16", subtitles: true });
  assert.equal(
    full.description,
    "Script, storyboard, 2 vertical scenes of 5 s, each started from its own keyframe image, a voice-over for each, joined into one video with subtitles, a cover image and a caption.",
  );
  assert.equal(
    needsInWords(templateNeeds(full.steps)),
    "The project needs a video model, an image model and a speech model, and the server needs ffmpeg.",
  );
  // Every step depends only on steps before it, so the plan keeps all of it.
  const plan = parsePlan(JSON.stringify({ tasks: full.steps.map((s, i) => ({ seq: i + 1, title: s.title, objective: s.objective, agent: s.role, dependsOn: s.dependsOn ?? [], kind: s.kind, media: s.media })) }), 40);
  assert.ok(plan.ok, plan.error);
  assert.deepEqual(plan.tasks.map((t) => t.dependsOn), full.steps.map((s) => [...(s.dependsOn ?? [])].sort((a, b) => a - b)));
  assert.equal(plan.tasks[3]!.media?.imageFrom, 3);
});

test("subtitles need a voice-over and a joined video; what a template asks of a project is counted", () => {
  const noVoice = reelWorkflowTemplate({ scenes: 1, join: true, subtitles: true });
  assert.equal(noVoice.name, "Reel (1 scene, joined)");
  assert.deepEqual(noVoice.steps.find((s) => s.kind === "render")!.media, { aspectRatio: "9:16" });
  const noJoin = reelWorkflowTemplate({ scenes: 1, voiceOver: true, subtitles: true });
  assert.equal(noJoin.steps.some((s) => s.kind === "render"), false);

  assert.deepEqual(templateNeeds(reelWorkflowTemplate({ scenes: 3, keyframes: true, voiceOver: true, join: true }).steps), { tasks: 14, media: 10, image: true, video: true, audio: true, render: true });
  assert.deepEqual(templateNeeds(reelWorkflowTemplate({ scenes: 3 }).steps), { tasks: 7, media: 4, image: true, video: true, audio: false, render: false });
  // In words, for whoever sets a project up: only what the steps ask for.
  assert.equal(needsInWords({ image: true, video: false, audio: false, render: false }), "The project needs an image model.");
  assert.equal(needsInWords({ image: true, video: false, audio: true, render: false }), "The project needs an image model and a speech model.");
  assert.equal(needsInWords({ image: false, video: false, audio: false, render: true }), "The server needs ffmpeg.");
  assert.equal(needsInWords({ image: false, video: false, audio: false, render: false }), "");
  // The largest template still fits the limits a project can be given.
  const largest = templateNeeds(reelWorkflowTemplate({ scenes: REEL_MAX_SCENES, keyframes: true, voiceOver: true, join: true }).steps);
  assert.ok(largest.tasks <= 40 && largest.media <= 40, JSON.stringify(largest));
});

// ─── What a discovered model is for ──────────────────────────────────────────

test("a model's type is guessed from its id", () => {
  const cases: [string, string][] = [
    ["gpt-4o-mini", "chat"],
    ["claude-sonnet-4-5", "chat"],
    ["text-embedding-3-small", "embedding"],
    ["BAAI/bge-m3", "embedding"],
    ["gpt-image-1", "image"],
    ["dall-e-3", "image"],
    ["black-forest-labs/flux-1.1-pro", "image"],
    ["imagen-4.0-generate", "image"],
    ["sora-2", "video"],
    ["veo-3.1-fast", "video"],
    ["alibaba/wan-2.7", "video"],
    ["grok-imagine-video", "video"],
    ["tts-1-hd", "speech"],
    ["gemini-2.5-flash-preview-tts", "speech"],
    ["whisper-1", "transcription"],
    // A word inside another word is not a match.
    ["swan-large", "chat"],
    ["imaginer-7b", "chat"],
  ];
  for (const [id, type] of cases) assert.equal(guessModelType(id), type, id);
});

test("a discovered model is imported with what the provider says it is, else with the guess", () => {
  assert.deepEqual(suggestModel({ id: "gpt-image-1" }), { type: "image", capabilities: ["image_generation"] });
  assert.deepEqual(suggestModel({ id: "mystery", capabilities: ["text", "vision", "text"], contextWindow: 8000, displayName: "Mystery" }), {
    type: "chat",
    capabilities: ["text", "vision"],
    contextWindow: 8000,
    displayName: "Mystery",
  });
  // What the provider's list says wins over the name.
  assert.deepEqual(suggestModel({ id: "image-chat-pro", capabilities: ["text"] }).type, "chat");
  assert.deepEqual(capabilitiesForType("transcription"), ["audio"]);
  assert.equal(typeOfCapabilities(["speech_generation"]), "speech");
  assert.equal(typeOfCapabilities(["embeddings"]), "embedding");
  assert.equal(typeOfCapabilities([]), "chat");
});

// ─── Keys in error messages ──────────────────────────────────────────────────

test("keys of every provider, and this app's own, are taken out of error messages", () => {
  const cases = [
    "Bearer abc.def-123",
    "sk-ant-api03-abcdefghijklmnop",
    "AIzaSyA1234567890-not-a-real-key",
    "tvly-abcdefghijklmnop",
    "xn_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  ];
  for (const key of cases) {
    const message = sanitizeUpstreamError(`The request with ${key} failed`);
    assert.ok(!message.includes(key.replace(/^Bearer /, "")), message);
    assert.match(message, /^The request with .* failed$/);
  }
  assert.equal(sanitizeUpstreamError("GET /v1/models?key=SECRETVALUE&alt=sse failed"), "GET /v1/models?key=[redacted]&alt=sse failed");
  assert.equal(sanitizeUpstreamError("x".repeat(30) + " ok", 20), `${"x".repeat(17)}…`);
  // An ordinary message is left as it is.
  assert.equal(sanitizeUpstreamError("The model is overloaded. Try again in 20 seconds."), "The model is overloaded. Try again in 20 seconds.");
});
