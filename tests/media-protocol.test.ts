import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildImageRequest,
  buildVideoRequest,
  detectMediaApi,
  imageSizeFor,
  isValidJobId,
  linkDownloadPlan,
  orientationOf,
  parseImageResponse,
  parseVideoJob,
  resolveMediaApi,
  upstreamErrorText,
  videoContentPath,
  videoDownloadPlan,
  videoSizeFor,
  videoStatusPath,
} from "../src/lib/adapters/media-protocol";

// ─── Which style a provider speaks ───────────────────────────────────────────

test("detectMediaApi reads the style from the Base URL host", () => {
  assert.equal(detectMediaApi("https://api.x.ai/v1"), "xai");
  assert.equal(detectMediaApi("https://openrouter.ai/api/v1"), "openrouter");
  assert.equal(detectMediaApi("https://api.openai.com/v1"), "openai");
  assert.equal(detectMediaApi("http://127.0.0.1:4000/v1"), "openai");
  // Only the real hosts match, not look-alikes.
  assert.equal(detectMediaApi("https://notx.ai/v1"), "openai");
  assert.equal(detectMediaApi("https://openrouter.ai.example.com/v1"), "openai");
  assert.equal(detectMediaApi("not a url"), "openai");
});

test("resolveMediaApi prefers an explicit setting over the guess", () => {
  assert.equal(resolveMediaApi("xai", "https://proxy.example.com/v1"), "xai");
  assert.equal(resolveMediaApi("openai", "https://api.x.ai/v1"), "openai");
  assert.equal(resolveMediaApi("auto", "https://api.x.ai/v1"), "xai");
  assert.equal(resolveMediaApi(null, "https://openrouter.ai/api/v1"), "openrouter");
  assert.equal(resolveMediaApi("bogus", "https://api.example.com/v1"), "openai");
});

// ─── Sizes ───────────────────────────────────────────────────────────────────

test("orientationOf classifies aspect ratios", () => {
  assert.equal(orientationOf("1:1"), "square");
  assert.equal(orientationOf("9:16"), "portrait");
  assert.equal(orientationOf("16:9"), "landscape");
  assert.equal(orientationOf("19.5:9"), "landscape");
  assert.equal(orientationOf("auto"), null);
  assert.equal(orientationOf("0:9"), null);
  assert.equal(orientationOf(undefined), null);
});

test("imageSizeFor maps to the three universally accepted sizes", () => {
  assert.equal(imageSizeFor("1:1"), "1024x1024");
  assert.equal(imageSizeFor("9:16"), "1024x1536");
  assert.equal(imageSizeFor("3:4"), "1024x1536");
  assert.equal(imageSizeFor("16:9"), "1536x1024");
  assert.equal(imageSizeFor(undefined), undefined);
});

test("videoSizeFor treats the resolution as the short side", () => {
  assert.equal(videoSizeFor("9:16", "720p"), "720x1280");
  assert.equal(videoSizeFor("16:9", "720p"), "1280x720");
  assert.equal(videoSizeFor("9:16", "1080p"), "1080x1920");
  assert.equal(videoSizeFor("1:1", "480p"), "480x480");
  assert.equal(videoSizeFor("4:3", "720p"), "960x720");
  // No resolution: 720p. A resolution that is not "<n>p" is ignored.
  assert.equal(videoSizeFor("9:16", undefined), "720x1280");
  assert.equal(videoSizeFor("9:16", "2K"), "720x1280");
  // Odd results are rounded to even dimensions.
  assert.equal(videoSizeFor("3:2", "480p"), "720x480");
  assert.equal(videoSizeFor("21:9", "720p"), "1680x720");
  // Without an aspect ratio there is nothing to compute.
  assert.equal(videoSizeFor(undefined, "1080p"), undefined);
});

// ─── Image requests ──────────────────────────────────────────────────────────

test("openai-style image request", () => {
  const req = buildImageRequest("openai", {
    model: "gpt-image-2",
    prompt: "a lighthouse",
    n: 2,
    aspectRatio: "9:16",
    resolution: "2k",
  });
  assert.equal(req.path, "/images/generations");
  assert.deepEqual(req.body, {
    model: "gpt-image-2",
    prompt: "a lighthouse",
    n: 2,
    size: "1024x1536",
  });
});

test("openai-style image request: explicit size wins, n=1 and defaults are not sent", () => {
  const req = buildImageRequest("openai", {
    model: "m",
    prompt: "p",
    n: 1,
    aspectRatio: "9:16",
    size: "1008x1792",
  });
  assert.deepEqual(req.body, { model: "m", prompt: "p", size: "1008x1792" });
  assert.deepEqual(buildImageRequest("openai", { model: "m", prompt: "p" }).body, {
    model: "m",
    prompt: "p",
  });
});

test("xai-style image request asks for the bytes", () => {
  const req = buildImageRequest("xai", {
    model: "grok-imagine-image-2.0",
    prompt: "a lighthouse",
    aspectRatio: "9:16",
    resolution: "2k",
    size: "1024x1024", // not part of this style
  });
  assert.equal(req.path, "/images/generations");
  assert.deepEqual(req.body, {
    model: "grok-imagine-image-2.0",
    prompt: "a lighthouse",
    aspect_ratio: "9:16",
    resolution: "2k",
    response_format: "b64_json",
  });
});

test("xai-style image request keeps a response_format the caller chose", () => {
  const req = buildImageRequest("xai", {
    model: "m",
    prompt: "p",
    extra: { response_format: "url" },
  });
  assert.equal(req.body.response_format, "url");
});

test("openrouter-style image request", () => {
  const req = buildImageRequest("openrouter", {
    model: "openai/gpt-image-2",
    prompt: "a lighthouse",
    n: 3,
    aspectRatio: "16:9",
    resolution: "2K",
  });
  assert.equal(req.path, "/images");
  assert.deepEqual(req.body, {
    model: "openai/gpt-image-2",
    prompt: "a lighthouse",
    n: 3,
    aspect_ratio: "16:9",
    resolution: "2K",
  });
  // An exact size is sent alone: OpenRouter rejects it next to the others.
  const sized = buildImageRequest("openrouter", {
    model: "m",
    prompt: "p",
    aspectRatio: "16:9",
    resolution: "2K",
    size: "2048x1152",
  });
  assert.deepEqual(sized.body, { model: "m", prompt: "p", size: "2048x1152" });
});

test("extra parameters are passed through but cannot replace model, prompt or stream", () => {
  const req = buildImageRequest("openai", {
    model: "real-model",
    prompt: "real prompt",
    extra: {
      quality: "high",
      background: "transparent",
      model: "other-model",
      prompt: "other prompt",
      stream: true,
      nothing: undefined,
    },
  });
  assert.deepEqual(req.body, {
    quality: "high",
    background: "transparent",
    model: "real-model",
    prompt: "real prompt",
  });
});

test("a form field beats the same key in extra parameters", () => {
  const req = buildVideoRequest("xai", {
    model: "m",
    prompt: "p",
    durationSeconds: 6,
    extra: { duration: 15, generate_audio: false },
  });
  assert.equal(req.body.duration, 6);
  assert.equal(req.body.generate_audio, false);
});

// ─── Video requests ──────────────────────────────────────────────────────────

test("openai-style video request sends seconds as a string and a pixel size", () => {
  const req = buildVideoRequest("openai", {
    model: "veo",
    prompt: "waves",
    durationSeconds: 8,
    aspectRatio: "9:16",
    resolution: "720p",
  });
  assert.equal(req.path, "/videos");
  assert.deepEqual(req.body, { model: "veo", prompt: "waves", seconds: "8", size: "720x1280" });
});

test("openrouter-style video request", () => {
  const req = buildVideoRequest("openrouter", {
    model: "google/veo-3.1",
    prompt: "waves",
    durationSeconds: 8,
    aspectRatio: "9:16",
    resolution: "720p",
  });
  assert.equal(req.path, "/videos");
  assert.deepEqual(req.body, {
    model: "google/veo-3.1",
    prompt: "waves",
    duration: 8,
    aspect_ratio: "9:16",
    resolution: "720p",
  });
});

test("xai-style video request", () => {
  const req = buildVideoRequest("xai", {
    model: "grok-imagine-video-1.5",
    prompt: "waves",
    durationSeconds: 10,
    aspectRatio: "9:16",
    resolution: "1080p",
    size: "1080x1920",
  });
  assert.equal(req.path, "/videos/generations");
  assert.deepEqual(req.body, {
    model: "grok-imagine-video-1.5",
    prompt: "waves",
    duration: 10,
    aspect_ratio: "9:16",
    resolution: "1080p",
  });
});

test("a video request with only a prompt sends only model and prompt", () => {
  for (const api of ["openai", "openrouter", "xai"] as const) {
    assert.deepEqual(buildVideoRequest(api, { model: "m", prompt: "p" }).body, {
      model: "m",
      prompt: "p",
    });
  }
});

// ─── Image responses ─────────────────────────────────────────────────────────

test("parseImageResponse reads inline base64 and OpenAI token usage", () => {
  const parsed = parseImageResponse({
    created: 1,
    data: [{ b64_json: "AAAA" }, { b64_json: "BBBB", revised_prompt: "x" }],
    usage: { input_tokens: 12, output_tokens: 4000, total_tokens: 4012 },
  });
  assert.deepEqual(parsed.images, [{ b64: "AAAA" }, { b64: "BBBB" }]);
  assert.equal(parsed.inputTokens, 12);
  assert.equal(parsed.outputTokens, 4000);
  assert.equal(parsed.error, undefined);
});

test("parseImageResponse reads OpenRouter's usage names", () => {
  const parsed = parseImageResponse({
    data: [{ b64_json: "AAAA", media_type: "image/png" }],
    usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.04 },
  });
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.inputTokens, 0);
  assert.equal(parsed.outputTokens, 4175);
});

test("parseImageResponse reads links and data URLs", () => {
  const parsed = parseImageResponse({
    data: [
      { url: "https://imgen.x.ai/abc.jpg", mime_type: "image/jpeg" },
      { url: "data:image/png;base64,Q0NDQw==" },
      { url: "" },
      { nothing: true },
      "junk",
    ],
  });
  assert.deepEqual(parsed.images, [{ url: "https://imgen.x.ai/abc.jpg" }, { b64: "Q0NDQw==" }]);
});

test("parseImageResponse tolerates junk and surfaces an error payload", () => {
  assert.deepEqual(parseImageResponse(null).images, []);
  assert.deepEqual(parseImageResponse("nope").images, []);
  assert.deepEqual(parseImageResponse({ data: "x" }).images, []);
  const failed = parseImageResponse({ error: { message: "Content policy violation", code: "x" } });
  assert.deepEqual(failed.images, []);
  assert.equal(failed.error, "Content policy violation");
});

test("upstreamErrorText reads the error shapes providers use", () => {
  assert.equal(upstreamErrorText({ error: "plain text" }), "plain text");
  assert.equal(upstreamErrorText({ error: { message: "msg" } }), "msg");
  assert.equal(upstreamErrorText({ error: { code: "bad_request" } }), "bad_request");
  assert.equal(upstreamErrorText({ error: null }), undefined);
  assert.equal(upstreamErrorText({}), undefined);
  assert.equal(upstreamErrorText(undefined), undefined);
});

// ─── Video jobs ──────────────────────────────────────────────────────────────

test("parseVideoJob: xAI create and poll responses", () => {
  const created = parseVideoJob({ request_id: "d97415a1-5796-b7ec-379f-4e6819e08fdf" });
  assert.equal(created.id, "d97415a1-5796-b7ec-379f-4e6819e08fdf");
  assert.equal(created.state, "pending");

  assert.equal(parseVideoJob({ status: "pending" }).state, "pending");

  const done = parseVideoJob({
    status: "done",
    video: { url: "https://vidgen.x.ai/a/video.mp4", duration: 8, respect_moderation: true },
    model: "grok-imagine-video-1.5",
  });
  assert.equal(done.state, "done");
  assert.deepEqual(done.urls, ["https://vidgen.x.ai/a/video.mp4"]);
  assert.equal(done.durationSeconds, 8);

  const failed = parseVideoJob({ status: "failed" });
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /failed/);
  assert.equal(parseVideoJob({ status: "expired" }).state, "failed");
});

test("parseVideoJob: OpenAI-style job object", () => {
  const queued = parseVideoJob({
    id: "video_123",
    object: "video",
    status: "queued",
    progress: 0,
    seconds: "8",
    size: "720x1280",
    error: null,
  });
  assert.equal(queued.id, "video_123");
  assert.equal(queued.state, "pending");
  assert.equal(queued.durationSeconds, 8);
  assert.equal(queued.error, undefined);

  assert.equal(parseVideoJob({ id: "video_123", status: "in_progress", progress: 40 }).state, "pending");

  const done = parseVideoJob({ id: "video_123", status: "completed", seconds: "8" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.urls, []);

  const failed = parseVideoJob({
    id: "video_123",
    status: "failed",
    error: { code: "moderation_blocked", message: "Blocked by the safety system" },
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Blocked by the safety system");
});

test("parseVideoJob: OpenRouter job, links that need the key come first", () => {
  const submitted = parseVideoJob({
    id: "abc123",
    polling_url: "https://openrouter.ai/api/v1/videos/abc123",
    status: "pending",
  });
  assert.equal(submitted.id, "abc123");
  assert.equal(submitted.state, "pending");
  assert.deepEqual(submitted.urls, []);

  const done = parseVideoJob({
    id: "abc123",
    status: "completed",
    unsigned_urls: ["https://openrouter.ai/api/v1/videos/abc123/content?index=0"],
    urls: ["https://storage.example.com/signed.mp4?sig=1"],
    usage: { cost: 0.25, is_byok: false },
  });
  assert.equal(done.state, "done");
  assert.deepEqual(done.urls, [
    "https://openrouter.ai/api/v1/videos/abc123/content?index=0",
    "https://storage.example.com/signed.mp4?sig=1",
  ]);

  const failed = parseVideoJob({ id: "abc123", status: "failed", error: "Content policy violation" });
  assert.equal(failed.error, "Content policy violation");
  assert.equal(parseVideoJob({ id: "abc123", status: "cancelled" }).state, "failed");
});

test("parseVideoJob: unknown or missing status", () => {
  // Still working until proven otherwise…
  assert.equal(parseVideoJob({ id: "j", status: "warming_up" }).state, "pending");
  assert.equal(parseVideoJob({}).state, "pending");
  assert.equal(parseVideoJob(null).state, "pending");
  // …unless a file link is already there.
  assert.equal(parseVideoJob({ id: "j", url: "https://cdn.example.com/v.mp4" }).state, "done");
  assert.equal(parseVideoJob({ id: "j", status: "COMPLETED" }).state, "done");
});

test("job ids are single URL-safe tokens", () => {
  assert.ok(isValidJobId("video_68fa2938848c8190bb71"));
  assert.ok(isValidJobId("gen-vid-1789480874-Ab3dEf9hIjKlMnOpQrSt"));
  assert.equal(isValidJobId(""), false);
  assert.equal(isValidJobId("has space"), false);
  assert.equal(isValidJobId("line\nbreak"), false);
  assert.equal(isValidJobId(42), false);
  assert.equal(isValidJobId("x".repeat(301)), false);
  // Dot segments would be resolved away by the URL parser.
  assert.equal(isValidJobId(".."), false);
  assert.equal(isValidJobId("."), false);
  // An id that is not a plain token is dropped rather than used.
  assert.equal(parseVideoJob({ id: "a b" }).id, null);
});

test("job ids are escaped when they become part of a path", () => {
  assert.equal(videoStatusPath("abc123"), "/videos/abc123");
  assert.equal(videoStatusPath("../models"), "/videos/..%2Fmodels");
  assert.equal(videoContentPath("a/b?c"), "/videos/a%2Fb%3Fc/content");
});

// ─── Where the finished file comes from, and who gets the key ────────────────

test("download: OpenAI-style jobs use the content endpoint, with the key", () => {
  assert.deepEqual(videoDownloadPlan("https://proxy.example.com/v1/", "video_123", { urls: [] }), {
    url: "https://proxy.example.com/v1/videos/video_123/content",
    withAuth: true,
  });
});

test("download: a link on the provider's own origin gets the key", () => {
  assert.deepEqual(
    videoDownloadPlan("https://openrouter.ai/api/v1", "abc123", {
      urls: ["https://openrouter.ai/api/v1/videos/abc123/content?index=0"],
    }),
    { url: "https://openrouter.ai/api/v1/videos/abc123/content?index=0", withAuth: true },
  );
  // A relative link is resolved against the Base URL.
  assert.deepEqual(
    videoDownloadPlan("https://openrouter.ai/api/v1", "abc123", {
      urls: ["/api/v1/videos/abc123/content?index=0"],
    }),
    { url: "https://openrouter.ai/api/v1/videos/abc123/content?index=0", withAuth: true },
  );
});

test("download: a link to any other origin never gets the key", () => {
  const cases = [
    "https://vidgen.x.ai/a/video.mp4", // another host
    "https://api.x.ai.evil.example/video.mp4", // look-alike host
    "http://api.x.ai/video.mp4", // same host, other scheme
    "https://api.x.ai:8443/video.mp4", // same host, other port
  ];
  for (const url of cases) {
    const plan = videoDownloadPlan("https://api.x.ai/v1", "job", { urls: [url] });
    assert.equal(plan.url, url);
    assert.equal(plan.withAuth, false, url);
  }
});

test("download: links that are not http(s) are skipped", () => {
  const plan = videoDownloadPlan("https://api.example.com/v1", "job", {
    urls: ["file:///etc/passwd", "ftp://example.com/v.mp4", "https://cdn.example.com/v.mp4"],
  });
  assert.deepEqual(plan, { url: "https://cdn.example.com/v.mp4", withAuth: false });

  const none = videoDownloadPlan("https://api.example.com/v1", "job", {
    urls: ["javascript:alert(1)"],
  });
  assert.deepEqual(none, { url: "https://api.example.com/v1/videos/job/content", withAuth: true });
});

test("linkDownloadPlan: an image link gets the key only on the provider's own origin", () => {
  const base = "https://api.example.com/v1";
  assert.deepEqual(linkDownloadPlan(base, "https://api.example.com/files/a.png"), {
    url: "https://api.example.com/files/a.png",
    withAuth: true,
  });
  assert.deepEqual(linkDownloadPlan(base, "/files/a.png"), {
    url: "https://api.example.com/files/a.png",
    withAuth: true,
  });
  assert.deepEqual(linkDownloadPlan(base, "https://cdn.example.net/a.png?sig=abc"), {
    url: "https://cdn.example.net/a.png?sig=abc",
    withAuth: false,
  });
  // The default port is the same origin; any other port is not.
  assert.equal(linkDownloadPlan(base, "https://api.example.com:443/a.png")?.withAuth, true);
  assert.equal(linkDownloadPlan(base, "https://api.example.com:444/a.png")?.withAuth, false);
  // A link with credentials for another host in it is still that other host.
  assert.equal(linkDownloadPlan(base, "https://api.example.com@evil.example/a.png")?.withAuth, false);
});

test("linkDownloadPlan: only http(s) links can be fetched", () => {
  const base = "https://api.example.com/v1";
  for (const link of ["file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://h/a.png"]) {
    assert.equal(linkDownloadPlan(base, link), null, link);
  }
  // Without a usable Base URL nothing is the provider's own origin.
  assert.deepEqual(linkDownloadPlan("not a url", "https://cdn.example.net/a.png"), null);
});
