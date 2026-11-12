// End-to-end checks of image and video generation, against the mock provider.
// Started by scripts/e2e/run.mjs (`npm run test:e2e`), which also starts the
// mock and the app on a throwaway database. It needs a FRESH database: the
// first account it registers has to become the administrator.
//
//   ONLY=images,videos,library,limits,projects   run some parts only
import { readdir } from "node:fs/promises";
import { reelWorkflowTemplate } from "../../src/lib/creative/templates.ts";

const APP = process.env.E2E_APP_URL ?? "http://127.0.0.1:3100";
const MOCK = process.env.E2E_MOCK_URL ?? "http://127.0.0.1:4010";
/** The folder the app stores generated files in. */
const MEDIA_DIR = process.env.E2E_MEDIA_DIR;
/** The API key the mock expects. Not a real key. */
const KEY = "sk-mock-0123456789abcdefghijklmnopqrstuvwxyz-KEY";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

if (!MEDIA_DIR) {
  console.error("E2E_MEDIA_DIR is not set. Start these checks with: npm run test:e2e");
  process.exit(2);
}

// ─── Small test harness ──────────────────────────────────────────────────────

let passed = 0;
const failures = [];
let section = "";

function begin(name) {
  section = name;
  console.log(`\n── ${name}`);
}
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${section}: ${name}${detail !== undefined ? `\n         ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
    console.log(`  FAIL ${name}${detail !== undefined ? `  →  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A signed-in client: keeps the session cookie. */
function client() {
  let cookie = "";
  async function raw(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (init.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${APP}${path}`, { ...init, headers, redirect: "manual" });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const line of set) {
      const pair = line.split(";")[0];
      if (pair.startsWith("nexus_session=")) cookie = pair;
    }
    return res;
  }
  async function call(method, path, body) {
    const res = await raw(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, data, error: data?.error?.message ?? null, code: data?.error?.code ?? null };
  }
  return {
    raw,
    get: (path) => call("GET", path),
    post: (path, body = {}) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    del: (path) => call("DELETE", path),
    hasSession: () => Boolean(cookie),
  };
}

async function mockLog() {
  return (await fetch(`${MOCK}/__log`)).json();
}
async function mockReset() {
  await fetch(`${MOCK}/__reset`);
}
async function mediaFiles() {
  try {
    return (await readdir(MEDIA_DIR)).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/** Refresh a video until it is no longer pending. The app asks the provider at most every 3 s. */
async function settle(user, id, { tries = 10, gapMs = 3200 } = {}) {
  let last = null;
  const checkErrors = [];
  for (let i = 0; i < tries; i++) {
    const res = await user.post(`/api/media/${id}/refresh`);
    if (res.status !== 200) return { res, asset: null, checkErrors };
    last = res.data.asset;
    if (res.data.checkError) checkErrors.push(res.data.checkError);
    if (last.status !== "pending") break;
    await sleep(gapMs);
  }
  return { asset: last, checkErrors };
}

/** POST a run and collect its server-sent events. */
async function runProject(user, projectId, { onEvent } = {}) {
  const res = await user.raw(`/api/projects/${projectId}/run`, { method: "POST" });
  const events = [];
  if (!res.ok || !res.body) return { status: res.status, events, error: await res.text() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5).trim());
      events.push({ ...event, at: Date.now() });
      await onEvent?.(event);
    }
  }
  return { status: res.status, events };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const admin = client();
const bob = client();
const carol = client();
const anon = client();

const ids = { providers: {}, models: {}, agents: {} };

async function setup() {
  begin("Setup: accounts, providers, models");
  const a = await admin.post("/api/auth/register", { username: "admin", email: "admin@example.com", password: "correct-horse-battery" });
  eq("first account registers", a.status, 201);
  eq("first account is the administrator", a.data?.user?.role, "admin");
  const b = await bob.post("/api/auth/register", { username: "bob", email: "bob@example.com", password: "correct-horse-battery" });
  eq("second account is an ordinary user", b.data?.user?.role, "user");
  const c = await carol.post("/api/auth/register", { username: "carol", email: "carol@example.com", password: "correct-horse-battery" });
  eq("third account registers", c.status, 201);

  const providerDefs = {
    openai: { name: "Mock OpenAI-style", baseUrl: `${MOCK}/openai/v1` },
    openrouter: { name: "Mock OpenRouter", baseUrl: `${MOCK}/openrouter/api/v1`, mediaApi: "openrouter" },
    xai: { name: "Mock xAI", baseUrl: `${MOCK}/xai/v1`, mediaApi: "xai" },
    wrong: { name: "Mock xAI, set wrongly", baseUrl: `${MOCK}/xai/v1`, mediaApi: "openai" },
  };
  for (const [key, def] of Object.entries(providerDefs)) {
    const res = await admin.post("/api/providers", { adapter: "openai-compatible", authType: "bearer", apiKey: KEY, ...def });
    check(`provider "${def.name}" is created`, res.status === 201, res.error);
    ids.providers[key] = res.data?.provider?.id;
    eq(`  its image / video API setting is stored`, res.data?.provider?.mediaApi, def.mediaApi ?? "auto");
    check("  the key is not in the answer", !JSON.stringify(res.data).includes(KEY));
  }
  const anthropic = await admin.post("/api/providers", { name: "Mock Anthropic", adapter: "anthropic", baseUrl: `${MOCK}/openai/v1`, authType: "header", authHeaderName: "x-api-key", apiKey: KEY });
  check("an Anthropic provider is created (for the adapter check)", anthropic.status === 201, anthropic.error);
  ids.providers.anthropic = anthropic.data?.provider?.id;

  const bad = await admin.post("/api/providers", { name: "Bad setting", adapter: "openai-compatible", baseUrl: `${MOCK}/openai/v1`, authType: "none", mediaApi: "midjourney" });
  eq("an unknown image / video API setting is refused", bad.status, 400);

  const patched = await admin.patch(`/api/providers/${ids.providers.wrong}`, { mediaApi: "auto" });
  eq("the setting can be changed", patched.data?.provider?.mediaApi, "auto");
  const back = await admin.patch(`/api/providers/${ids.providers.wrong}`, { mediaApi: "openai" });
  eq("  and changed back", back.data?.provider?.mediaApi, "openai");
  const untouched = await admin.patch(`/api/providers/${ids.providers.wrong}`, { notes: "note" });
  eq("  and is kept when another field is edited", untouched.data?.provider?.mediaApi, "openai");

  const test = await admin.post(`/api/providers/${ids.providers.openai}/test`);
  check("the connection test reaches the mock", test.status === 200 && test.data?.ok !== false, test);

  async function model(key, provider, modelId, capabilities, extra = {}) {
    const res = await admin.post("/api/models", { providerId: ids.providers[provider], modelId, capabilities, ...extra });
    if (res.status !== 201) check(`model ${key} is created`, false, res.error);
    ids.models[key] = res.data?.model?.id;
    return res.data?.model;
  }
  const chatModel = await model("chat", "openai", "chat-mini", ["text", "streaming"], { inputPricePerMTok: 1, outputPricePerMTok: 2 });
  check("a chat model is created", Boolean(chatModel?.id));
  for (const style of ["openai", "openrouter", "xai"]) {
    const img = await model(`img_${style}`, style, "img-ok", ["image_generation"], { pricePerImage: 0.04 });
    eq(`image model on ${style}: the per-image price is stored`, img?.pricePerImage, 0.04);
    const vid = await model(`vid_${style}`, style, "vid-ok", ["video_generation"], { pricePerSecond: 0.1 });
    eq(`video model on ${style}: the per-second price is stored`, vid?.pricePerSecond, 0.1);
  }
  await model("img_wrong", "wrong", "img-ok", ["image_generation"]);
  await model("vid_wrong", "wrong", "vid-ok", ["video_generation"]);
  for (const id of ["img-fail", "img-leak", "img-empty", "img-svg", "img-html-link", "img-evil-redirect", "img-localhost-redirect", "img-loop", "img-too-big", "img-file-link"]) {
    await model(id, "openai", id, ["image_generation"]);
  }
  for (const id of ["vid-reject", "vid-fail", "vid-slow", "vid-gone", "vid-flaky", "vid-html", "vid-instant"]) {
    await model(id, "openai", id, ["video_generation"], { pricePerSecond: 0.1 });
  }
  await model("vid-fail-xai", "xai", "vid-fail", ["video_generation"]);
  await model("vid-fail-or", "openrouter", "vid-fail", ["video_generation"]);
  await model("vid-html-xai", "xai", "vid-html", ["video_generation"]);
  await model("img_anthropic", "anthropic", "claude-image", ["image_generation"]);
  await model("both", "openai", "img-ok-and-chat", ["text", "image_generation"]);
  check("all test models are created", Object.values(ids.models).every(Boolean), ids.models);
}

// ─── Images ──────────────────────────────────────────────────────────────────

const made = { images: [], videos: [] };

async function images() {
  begin("Images: OpenAI style");
  await mockReset();
  const before = (await mediaFiles()).length;
  let res = await admin.post("/api/media/images", { modelRowId: ids.models.img_openai, prompt: "  A lighthouse at dusk  ", n: 2, aspectRatio: "9:16" });
  eq("two images are generated", [res.status, res.data?.assets?.length], [201, 2]);
  let assets = res.data?.assets ?? [];
  made.images.push(...assets);
  let log = await mockLog();
  const sent = log.find((r) => r.method === "POST");
  eq("request path", sent?.path, "/openai/v1/images/generations");
  eq("request body", sent?.body, { model: "img-ok", prompt: "A lighthouse at dusk", n: 2, size: "1024x1536" });
  eq("the key is sent to the provider", sent?.authorization, `Bearer ${KEY}`);
  const first = assets[0] ?? {};
  eq("asset fields", [first.kind, first.status, first.mimeType, first.modelLabel, first.prompt, first.options], ["image", "ready", "image/png", "img-ok", "A lighthouse at dusk", { aspectRatio: "9:16" }]);
  eq("the file is served from the app", first.url, `/api/media/${first.id}/file`);
  check("cost: 2 × $0.04, shared between the two", Math.abs((assets[0]?.estimatedCost ?? 0) + (assets[1]?.estimatedCost ?? 0) - 0.08) < 1e-9, assets.map((a) => a.estimatedCost));
  eq("two files are in the media folder", (await mediaFiles()).length, before + 2);

  const file = await admin.raw(first.url);
  const bytes = Buffer.from(await file.arrayBuffer());
  eq("the file is served", [file.status, file.headers.get("content-type"), file.headers.get("x-content-type-options")], [200, "image/png", "nosniff"]);
  check("it is the PNG the provider sent", bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.length === first.sizeBytes, bytes.length);
  check("shown inline by default", (file.headers.get("content-disposition") ?? "").startsWith("inline;"), file.headers.get("content-disposition"));
  check("private caching only", (file.headers.get("cache-control") ?? "").includes("private"), file.headers.get("cache-control"));
  const download = await admin.raw(`${first.url}?download=1`);
  check("?download=1 offers a download with a neutral name", /^attachment; filename="xiero-image-[0-9a-f]{8}\.png"$/.test(download.headers.get("content-disposition") ?? ""), download.headers.get("content-disposition"));
  await download.arrayBuffer();

  begin("Images: extra parameters");
  await mockReset();
  res = await admin.post("/api/media/images", { modelRowId: ids.models.img_openai, prompt: "A lighthouse", size: "1536x1024", aspectRatio: "9:16", extra: { quality: "high", model: "evil", prompt: "evil", stream: true, size: "1x1" } });
  eq("generated", res.status, 201);
  made.images.push(...(res.data?.assets ?? []));
  eq("extra parameters are added; model, prompt and stream cannot be replaced; a form field wins", (await mockLog())[0]?.body, { quality: "high", size: "1536x1024", model: "img-ok", prompt: "A lighthouse" });

  begin("Images: OpenRouter style (links)");
  await mockReset();
  res = await admin.post("/api/media/images", { modelRowId: ids.models.img_openrouter, prompt: "A lighthouse", n: 4, aspectRatio: "16:9", resolution: "2K" });
  eq("four images, from three kinds of link and a data URL", [res.status, res.data?.assets?.length], [201, 4]);
  made.images.push(...(res.data?.assets ?? []));
  log = await mockLog();
  eq("request path and body", [log[0]?.path, log[0]?.body], ["/openrouter/api/v1/images", { model: "img-ok", prompt: "A lighthouse", n: 4, aspect_ratio: "16:9", resolution: "2K" }]);
  const cdn = log.filter((r) => r.server === "cdn");
  eq("the other-origin link is followed through its redirect", cdn.map((r) => r.path), ["/cdn/redirect/a.png", "/cdn/a.png"]);
  check("the key is never sent to the other origin", cdn.every((r) => r.authorization === null && r.xApiKey === null), cdn);
  const own = log.filter((r) => r.server === "api" && r.path.includes("/files/"));
  eq("links on the provider's own origin are fetched, relative ones too", own.map((r) => r.path), ["/openrouter/api/v1/files/own.png", "/openrouter/api/v1/files/relative.png"]);
  check("  with the key", own.every((r) => r.authorization === `Bearer ${KEY}`), own);
  check("cost uses the per-image price", Math.abs((res.data?.assets ?? []).reduce((sum, a) => sum + (a.estimatedCost ?? 0), 0) - 0.16) < 1e-9);

  begin("Images: xAI style");
  await mockReset();
  res = await admin.post("/api/media/images", { modelRowId: ids.models.img_xai, prompt: "A lighthouse", aspectRatio: "3:4", resolution: "2k" });
  eq("generated", [res.status, res.data?.assets?.length], [201, 1]);
  made.images.push(...(res.data?.assets ?? []));
  log = await mockLog();
  eq("request path and body (asks for the bytes, sends n only above 1)", [log[0]?.path, log[0]?.body], ["/xai/v1/images/generations", { model: "img-ok", prompt: "A lighthouse", aspect_ratio: "3:4", resolution: "2k", response_format: "b64_json" }]);
  eq("nothing was fetched from another origin", log.filter((r) => r.server === "cdn").length, 0);

  begin("Images: a wrong image / video API setting");
  res = await admin.post("/api/media/images", { modelRowId: ids.models.img_wrong, prompt: "A lighthouse" });
  // The xAI image path happens to be the OpenAI one, so images still work there.
  eq("xAI images work with the OpenAI style too (same path)", res.status, 201);
  made.images.push(...(res.data?.assets ?? []));

  begin("Images: validation and who may ask");
  const cases = [
    ["an empty prompt", { modelRowId: ids.models.img_openai, prompt: "   " }, 400],
    ["five images at once", { modelRowId: ids.models.img_openai, prompt: "x", n: 5 }, 400],
    ["a malformed aspect ratio", { modelRowId: ids.models.img_openai, prompt: "x", aspectRatio: "wide" }, 400],
    ["a malformed size", { modelRowId: ids.models.img_openai, prompt: "x", size: "big" }, 400],
    ["a prompt over 4,000 characters", { modelRowId: ids.models.img_openai, prompt: "x".repeat(4001) }, 400],
    ["extra parameters that are not an object", { modelRowId: ids.models.img_openai, prompt: "x", extra: [1, 2] }, 400],
    ["an unknown model", { modelRowId: "nope", prompt: "x" }, 404],
    ["a chat model", { modelRowId: ids.models.chat, prompt: "x" }, 400],
    ["a video model", { modelRowId: ids.models.vid_openai, prompt: "x" }, 400],
    ["a model on an adapter without image support", { modelRowId: ids.models.img_anthropic, prompt: "x" }, 400],
  ];
  for (const [name, body, status] of cases) {
    const r = await carol.post("/api/media/images", body);
    check(`${name} is refused (${status})`, r.status === status, `${r.status} ${r.error}`);
  }
  eq("signed out: 401", (await anon.post("/api/media/images", { modelRowId: ids.models.img_openai, prompt: "x" })).status, 401);
  const disabled = await admin.patch(`/api/models/${ids.models.img_xai}`, { enabled: false });
  eq("a model can be disabled", disabled.data?.model?.enabled, false);
  eq("  and then cannot generate", (await carol.post("/api/media/images", { modelRowId: ids.models.img_xai, prompt: "x" })).status, 400);
  await admin.patch(`/api/models/${ids.models.img_xai}`, { enabled: true });

  begin("Images: provider failures and unsafe answers");
  const filesBefore = (await mediaFiles()).length;
  const listBefore = (await bob.get("/api/media")).data?.assets?.length;
  const failing = [
    ["img-fail", "the provider's refusal is passed on", /safety system/],
    ["img-empty", "an answer without an image is an error", /without an image/],
    ["img-svg", "an SVG is not stored", /not a PNG, JPEG, GIF or WebP image/],
    ["img-html-link", "an HTML page behind an image link is not stored", /not a PNG, JPEG, GIF or WebP image/],
    ["img-evil-redirect", "a redirect to the cloud metadata address is refused", /disallowed private address|cannot be used/],
    ["img-localhost-redirect", "a redirect to localhost is refused", /localhost is not allowed|cannot be used/],
    ["img-loop", "a redirect loop ends", /Too many redirects/],
    ["img-too-big", "a file declared larger than the limit is refused", /larger than the .* limit/],
    ["img-file-link", "a file:// link is refused", /cannot be used/],
  ];
  for (const [modelKey, name, pattern] of failing) {
    await mockReset();
    const r = await bob.post("/api/media/images", { modelRowId: ids.models[modelKey], prompt: "A lighthouse" });
    check(`${name}`, r.status >= 400 && pattern.test(r.error ?? ""), `${r.status} ${r.error}`);
  }
  await mockReset();
  const leak = await bob.post("/api/media/images", { modelRowId: ids.models["img-leak"], prompt: "A lighthouse" });
  check("an error that repeats the key is redacted", leak.status >= 400 && !JSON.stringify(leak.data).includes(KEY) && !JSON.stringify(leak.data).includes("sk-mock"), leak.error);
  const metadataHit = (await mockLog()).some((r) => r.path.includes("meta-data"));
  check("the mock never saw a request for the metadata path", !metadataHit);
  eq("failed requests leave no file behind", (await mediaFiles()).length, filesBefore);
  eq("  and no library entry", (await bob.get("/api/media")).data?.assets?.length, listBefore);
}

// ─── Videos ──────────────────────────────────────────────────────────────────

async function videos() {
  begin("Videos: OpenAI style");
  await mockReset();
  let res = await admin.post("/api/media/videos", { modelRowId: ids.models.vid_openai, prompt: "Waves below a lighthouse", durationSeconds: 8, aspectRatio: "9:16", resolution: "720p" });
  eq("a video starts as pending", [res.status, res.data?.asset?.status, res.data?.asset?.url], [201, "pending", null]);
  const openaiVideo = res.data?.asset;
  let log = await mockLog();
  eq("request path and body (seconds as a string, a pixel size)", [log[0]?.path, log[0]?.body], ["/openai/v1/videos", { model: "vid-ok", prompt: "Waves below a lighthouse", seconds: "8", size: "720x1280" }]);
  eq("its file is not available yet", (await admin.raw(`/api/media/${openaiVideo.id}/file`)).status, 404);

  const twice = await Promise.all([admin.post(`/api/media/${openaiVideo.id}/refresh`), admin.post(`/api/media/${openaiVideo.id}/refresh`), admin.post(`/api/media/${openaiVideo.id}/refresh`)]);
  eq("three refreshes at once all answer", twice.map((r) => r.status), [200, 200, 200]);
  log = await mockLog();
  eq("  but the provider is asked once", log.filter((r) => r.method === "GET" && /^\/openai\/v1\/videos\/[^/]+$/.test(r.path)).length, 1);

  let done = await settle(admin, openaiVideo.id);
  const v = done.asset ?? {};
  eq("it becomes ready", [v.status, v.mimeType, v.sizeBytes, v.durationSeconds], ["ready", "video/mp4", 300000, 8]);
  check("cost: 8 s × $0.10", Math.abs((v.estimatedCost ?? 0) - 0.8) < 1e-9, v.estimatedCost);
  made.videos.push(v);
  log = await mockLog();
  const content = log.find((r) => r.path.endsWith("/content"));
  check("the file comes from the content endpoint, with the key", content?.authorization === `Bearer ${KEY}`, content);
  eq("exactly one download", log.filter((r) => r.path.endsWith("/content")).length, 1);
  const again = await admin.post(`/api/media/${v.id}/refresh`);
  eq("refreshing a finished video changes nothing", [again.status, again.data?.asset?.status], [200, "ready"]);
  eq("  and does not ask the provider again", (await mockLog()).length, log.length);

  begin("Videos: byte ranges (seeking in the player)");
  const url = `/api/media/${v.id}/file`;
  const full = await admin.raw(url);
  const fullBytes = Buffer.from(await full.arrayBuffer());
  eq("whole file", [full.status, full.headers.get("content-type"), full.headers.get("accept-ranges"), full.headers.get("content-length"), fullBytes.length], [200, "video/mp4", "bytes", "300000", 300000]);
  const ranges = [
    ["bytes=0-99", 206, "bytes 0-99/300000", 100],
    ["bytes=299990-", 206, "bytes 299990-299999/300000", 10],
    ["bytes=-5", 206, "bytes 299995-299999/300000", 5],
    ["bytes=100-100", 206, "bytes 100-100/300000", 1],
    ["bytes=0-99999999", 206, "bytes 0-299999/300000", 300000],
  ];
  for (const [range, status, contentRange, length] of ranges) {
    const r = await admin.raw(url, { headers: { range } });
    const body = Buffer.from(await r.arrayBuffer());
    eq(`${range}`, [r.status, r.headers.get("content-range"), body.length], [status, contentRange, length]);
  }
  const part = Buffer.from(await (await admin.raw(url, { headers: { range: "bytes=4-11" } })).arrayBuffer());
  eq("a range holds the right bytes", part.toString("latin1"), "ftypisom");
  const beyond = await admin.raw(url, { headers: { range: "bytes=300000-" } });
  eq("a range past the end: 416", [beyond.status, beyond.headers.get("content-range")], [416, "bytes */300000"]);
  await beyond.arrayBuffer();

  begin("Videos: OpenRouter style");
  await mockReset();
  res = await admin.post("/api/media/videos", { modelRowId: ids.models.vid_openrouter, prompt: "Waves", durationSeconds: 5, aspectRatio: "16:9", resolution: "1080p" });
  eq("started", [res.status, res.data?.asset?.status], [201, "pending"]);
  log = await mockLog();
  eq("request path and body", [log[0]?.path, log[0]?.body], ["/openrouter/api/v1/videos", { model: "vid-ok", prompt: "Waves", duration: 5, aspect_ratio: "16:9", resolution: "1080p" }]);
  done = await settle(admin, res.data.asset.id);
  eq("ready", [done.asset?.status, done.asset?.sizeBytes, done.asset?.durationSeconds], ["ready", 300000, 5]);
  made.videos.push(done.asset);
  log = await mockLog();
  let cdn = log.filter((r) => r.server === "cdn");
  check("downloaded from the keyless link, through its redirect", cdn.length === 2 && cdn[0].path.startsWith("/cdn/redirect/or-") && cdn[1].path.startsWith("/cdn/or-"), cdn.map((r) => r.path));
  check("the key is never sent to the other origin", cdn.every((r) => r.authorization === null), cdn);

  begin("Videos: xAI style");
  await mockReset();
  res = await admin.post("/api/media/videos", { modelRowId: ids.models.vid_xai, prompt: "Waves", durationSeconds: 8, aspectRatio: "9:16", resolution: "720p", extra: { seed: 7 } });
  eq("started", [res.status, res.data?.asset?.status], [201, "pending"]);
  log = await mockLog();
  eq("request path and body", [log[0]?.path, log[0]?.body], ["/xai/v1/videos/generations", { seed: 7, model: "vid-ok", prompt: "Waves", duration: 8, aspect_ratio: "9:16", resolution: "720p" }]);
  done = await settle(admin, res.data.asset.id);
  eq("ready; the length the provider reports replaces the requested one", [done.asset?.status, done.asset?.durationSeconds], ["ready", 6]);
  check("cost follows the reported length: 6 s × $0.10", Math.abs((done.asset?.estimatedCost ?? 0) - 0.6) < 1e-9, done.asset?.estimatedCost);
  made.videos.push(done.asset);
  log = await mockLog();
  check("status is read from /videos/{request_id}", log.some((r) => r.method === "GET" && /^\/xai\/v1\/videos\/req_/.test(r.path)));
  cdn = log.filter((r) => r.server === "cdn");
  check("the file comes from video.url, without the key", cdn.length === 1 && cdn[0].authorization === null, cdn);

  begin("Videos: a wrong image / video API setting");
  res = await admin.post("/api/media/videos", { modelRowId: ids.models.vid_wrong, prompt: "Waves" });
  check("the provider's 404 is reported, nothing is left pending", res.status >= 400 && /404|No route/.test(res.error ?? ""), `${res.status} ${res.error}`);

  begin("Videos: failures");
  res = await bob.post("/api/media/videos", { modelRowId: ids.models["vid-reject"], prompt: "Waves" });
  check("a request the provider rejects is an error", res.status >= 400 && /moderation/.test(res.error ?? ""), `${res.status} ${res.error}`);
  eq("  and leaves nothing in the library", (await bob.get("/api/media?kind=video")).data?.assets?.length, 0);

  for (const [key, label, pattern] of [
    ["vid-fail", "OpenAI style", /moderation system/],
    ["vid-fail-or", "OpenRouter style", /provider error/],
    ["vid-fail-xai", "xAI style", /Content policy/],
  ]) {
    res = await bob.post("/api/media/videos", { modelRowId: ids.models[key], prompt: "Waves" });
    done = await settle(bob, res.data?.asset?.id);
    check(`a job that fails at the provider (${label}) becomes failed, with the reason`, done.asset?.status === "failed" && pattern.test(done.asset?.error ?? ""), done.asset);
    eq("  it has no file", done.asset?.url, null);
  }

  res = await bob.post("/api/media/videos", { modelRowId: ids.models["vid-gone"], prompt: "Waves" });
  done = await settle(bob, res.data?.asset?.id, { tries: 1 });
  check("a job the provider no longer has fails at once", done.asset?.status === "failed" && /no longer has this video/.test(done.asset?.error ?? ""), done.asset);

  res = await bob.post("/api/media/videos", { modelRowId: ids.models["vid-flaky"], prompt: "Waves" });
  const flaky = await bob.post(`/api/media/${res.data?.asset?.id}/refresh`);
  check("a provider hiccup keeps the video pending and says why", flaky.data?.asset?.status === "pending" && /503/.test(flaky.data?.checkError ?? ""), flaky.data);
  await sleep(3200);
  done = await settle(bob, res.data?.asset?.id);
  eq("  and it still finishes afterwards", done.asset?.status, "ready");

  const filesBefore = (await mediaFiles()).length;
  for (const [key, label] of [["vid-html", "content endpoint"], ["vid-html-xai", "link"]]) {
    res = await bob.post("/api/media/videos", { modelRowId: ids.models[key], prompt: "Waves" });
    done = await settle(bob, res.data?.asset?.id);
    check(`a finished "video" that is an HTML page (${label}) is refused for good`, done.asset?.status === "failed" && /not an MP4, MOV or WebM video/.test(done.asset?.error ?? ""), done.asset);
  }
  eq("  nothing was stored", (await mediaFiles()).length, filesBefore);

  res = await bob.post("/api/media/videos", { modelRowId: ids.models["vid-instant"], prompt: "Waves", durationSeconds: 4 });
  eq("a job that is finished when it is created is ready at once", [res.status, res.data?.asset?.status, res.data?.asset?.sizeBytes], [201, "ready", 300000]);

  begin("Videos: abandoning one");
  res = await bob.post("/api/media/videos", { modelRowId: ids.models["vid-slow"], prompt: "Waves" });
  const slow = res.data?.asset;
  eq("pending", slow?.status, "pending");
  eq("deleted while pending", (await bob.del(`/api/media/${slow.id}`)).status, 200);
  eq("refreshing it afterwards: 404", (await bob.post(`/api/media/${slow.id}/refresh`)).status, 404);

  begin("Videos: validation");
  for (const [name, body] of [
    ["61 seconds", { modelRowId: ids.models.vid_openai, prompt: "x", durationSeconds: 61 }],
    ["half a second", { modelRowId: ids.models.vid_openai, prompt: "x", durationSeconds: 0.5 }],
    ["an image model", { modelRowId: ids.models.img_openai, prompt: "x" }],
    ["no prompt", { modelRowId: ids.models.vid_openai }],
  ]) {
    eq(`${name} is refused`, (await carol.post("/api/media/videos", body)).status, 400);
  }
}

// ─── Library, access, limits ─────────────────────────────────────────────────

async function library() {
  begin("Library and access");
  const mine = await admin.get("/api/media");
  check("the library lists own media, newest first", mine.status === 200 && mine.data.assets.length >= 12 && mine.data.assets.every((a, i, all) => i === 0 || all[i - 1].createdAt >= a.createdAt), mine.data?.assets?.length);
  eq("no owner names in one's own list", mine.data.assets.some((a) => "owner" in a), false);
  eq("no further page", mine.data.nextOffset, null);
  const onlyVideos = await admin.get("/api/media?kind=video");
  check("?kind=video lists videos only", onlyVideos.data.assets.length >= 3 && onlyVideos.data.assets.every((a) => a.kind === "video"));
  eq("?kind=bogus: 400", (await admin.get("/api/media?kind=bogus")).status, 400);
  eq("signed out: 401", (await anon.get("/api/media")).status, 401);

  const all = await admin.get("/api/media?scope=all");
  const owners = new Set(all.data.assets.map((a) => a.owner));
  check("an administrator can list everyone's media, with owners", owners.has("admin") && owners.has("bob"), [...owners]);
  eq("an ordinary user cannot", (await bob.get("/api/media?scope=all")).status, 403);

  const target = made.images[0];
  eq("another user's asset: 403", (await bob.get(`/api/media/${target.id}`)).status, 403);
  eq("  its file: 403", (await bob.raw(`/api/media/${target.id}/file`)).status, 403);
  eq("  refresh: 403", (await bob.post(`/api/media/${target.id}/refresh`)).status, 403);
  eq("  delete: 403", (await bob.del(`/api/media/${target.id}`)).status, 403);
  eq("signed out, a file: 401", (await anon.raw(`/api/media/${target.id}/file`)).status, 401);
  eq("an unknown id: 404", (await admin.get("/api/media/00000000-0000-4000-8000-000000000000")).status, 404);
  eq("an id that is not an id: 404", (await admin.raw("/api/media/..%2F..%2Fnexus.db/file")).status, 404);
  const bobs = (await bob.get("/api/media")).data.assets.find((a) => a.status === "ready");
  eq("an administrator can open another user's file", (await admin.raw(`/api/media/${bobs.id}/file`)).status, 200);

  begin("Deleting");
  const files = await mediaFiles();
  const victim = made.images[1];
  check("its file is in the media folder", files.some((f) => f.startsWith(victim.id)), files.length);
  eq("deleted", (await admin.del(`/api/media/${victim.id}`)).status, 200);
  check("the file is gone from the media folder", !(await mediaFiles()).some((f) => f.startsWith(victim.id)));
  eq("the asset is gone", (await admin.get(`/api/media/${victim.id}`)).status, 404);
  eq("its file address answers 404", (await admin.raw(`/api/media/${victim.id}/file`)).status, 404);

  const stored = await mediaFiles();
  const everything = (await admin.get("/api/media?scope=all")).data.assets;
  const ready = everything.filter((a) => a.status === "ready");
  eq("the media folder holds exactly one file per ready asset", stored.length, ready.length);
  check("every file is named <asset id>.<ext>", stored.every((f) => /^[0-9a-f-]{36}\.(png|jpg|gif|webp|mp4|mov|webm)$/.test(f)), stored);

  begin("Models: verified marks and chat guards");
  const models = (await admin.get("/api/models")).data.models;
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  eq("a successful image marks image generation as verified", byId[ids.models.img_openai].capabilities, [{ capability: "image_generation", verified: true }]);
  eq("a successful video marks video generation as verified", byId[ids.models.vid_openai].capabilities, [{ capability: "video_generation", verified: true }]);
  eq("a model that never succeeded stays unverified", byId[ids.models["img-fail"]].capabilities, [{ capability: "image_generation", verified: false }]);
  const edited = await admin.patch(`/api/models/${ids.models.img_openai}`, { pricePerImage: 0.05, capabilities: ["image_generation"], displayName: "Mock Image" });
  eq("editing a model keeps the verified mark", edited.data?.model?.capabilities, [{ capability: "image_generation", verified: true }]);
  eq("  and stores the new price and name", [edited.data?.model?.pricePerImage, edited.data?.model?.displayName], [0.05, "Mock Image"]);
  const cleared = await admin.patch(`/api/models/${ids.models.img_openai}`, { pricePerImage: null });
  eq("a price can be cleared", cleared.data?.model?.pricePerImage, null);
  await admin.patch(`/api/models/${ids.models.img_openai}`, { pricePerImage: 0.04 });

  const test = await admin.post(`/api/models/${ids.models.img_openai}/test`);
  check("the chat test is refused for an image model", test.status === 400 && /Creative Studio/.test(test.error ?? ""), test.error);
  const chatTest = await admin.post(`/api/models/${ids.models.chat}/test`);
  check("the chat test still works for a chat model", chatTest.status === 200 && chatTest.data?.ok === true, chatTest.data);
  const chat = await admin.post("/api/chat", { modelRowId: ids.models.img_openai, messages: [{ role: "user", content: "hi" }] });
  check("chat refuses an image model", chat.status === 400 && /only generates images or videos/.test(chat.error ?? ""), `${chat.status} ${chat.error}`);
  const chatBoth = await admin.raw("/api/chat", { method: "POST", body: JSON.stringify({ modelRowId: ids.models.both, messages: [{ role: "user", content: "hi" }] }) });
  eq("chat accepts a model marked for both text and images", chatBoth.status, 200);
  await chatBoth.text();
  const agent = await admin.post("/api/agents", { name: "Bad", role: "Bad", primaryModelRowId: ids.models.vid_openai });
  check("an agent cannot use a video model", agent.status === 400 && /cannot be an agent's model/.test(agent.error ?? ""), agent.error);

  begin("Usage");
  const usage = (await admin.get("/api/usage")).data?.summary;
  check("the usage summary is served", Boolean(usage), usage);
  console.log(`       summary keys: ${Object.keys(usage ?? {}).join(", ")}`);
}

async function limits() {
  begin("Limits per user");
  // Carol has made 4 video requests (validation) in the last minute or so.
  await sleep(1000);
  const results = [];
  for (let i = 0; i < 12; i++) {
    results.push(await carol.post("/api/media/videos", { modelRowId: ids.models["vid-slow"], prompt: `Waves ${i}` }));
  }
  const statuses = results.map((r) => r.status);
  const firstLimited = statuses.indexOf(429);
  check("video requests are rate limited per user (10 a minute)", firstLimited !== -1 && firstLimited <= 10 && statuses.slice(firstLimited).every((s) => s === 429), statuses);
  check("  with a message that says what to do", /Wait a minute/.test(results[firstLimited]?.error ?? ""), results[firstLimited]?.error);
  eq("another user is not affected", (await admin.get("/api/media")).status, 200);
  const pending = (await carol.get("/api/media?kind=video")).data.assets.filter((a) => a.status === "pending");
  console.log(`       carol has ${pending.length} videos pending`);
  for (const asset of pending) await carol.del(`/api/media/${asset.id}`);
  eq("pending videos can all be deleted", (await carol.get("/api/media?kind=video")).data.assets.filter((a) => a.status === "pending").length, 0);
}

// ─── Projects ────────────────────────────────────────────────────────────────

async function projects() {
  begin("Projects: agents, workflow, creation checks");
  for (const [name, role] of [["Clara", "Creative Director"], ["Vito", "Video Artist"], ["Dee", "Designer"], ["Cody", "Copywriter"], ["Writer", "Writer"]]) {
    const res = await admin.post("/api/agents", { name, role, instructions: `You are the ${role}.`, primaryModelRowId: ids.models.chat });
    check(`agent ${name} (${role})`, res.status === 201, res.error);
    ids.agents[name] = res.data?.agent?.id;
  }

  const template = reelWorkflowTemplate({ scenes: 2, clipSeconds: 6 });
  const wf = await admin.post("/api/workflows", template);
  check("the Reel template is accepted as a workflow", wf.status === 201, wf.error);
  const workflowId = wf.data?.workflow?.id;
  eq("its steps keep their kind and options", wf.data?.workflow?.steps?.map((s) => [s.kind ?? "text", s.media ?? null]), [
    ["text", null],
    ["text", null],
    ["video", { aspectRatio: "9:16", durationSeconds: 6 }],
    ["video", { aspectRatio: "9:16", durationSeconds: 6 }],
    ["image", { aspectRatio: "9:16" }],
    ["text", null],
  ]);
  const badStep = await admin.post("/api/workflows", { name: "Bad", steps: [{ title: "t", objective: "o", role: "r", kind: "audio" }] });
  eq("a step of an unknown kind is refused", badStep.status, 400);
  const badMedia = await admin.post("/api/workflows", { name: "Bad", steps: [{ title: "t", objective: "o", role: "r", kind: "video", media: { durationSeconds: 600 } }] });
  eq("a step with a 600-second video is refused", badMedia.status, 400);

  const base = { title: "Lighthouse Reel", goal: "A Reel about a lighthouse keeper.", managerModelRowId: ids.models.chat, workflowId };
  let res = await admin.post("/api/projects", { ...base, imageModelRowId: ids.models.img_openai });
  check("a media workflow without a video model is refused at creation", res.status === 400 && /video steps/.test(res.error ?? ""), res.error);
  res = await admin.post("/api/projects", { ...base, videoModelRowId: ids.models.vid_xai });
  check("  and without an image model", res.status === 400 && /image steps/.test(res.error ?? ""), res.error);
  res = await admin.post("/api/projects", { ...base, imageModelRowId: ids.models.img_openai, videoModelRowId: ids.models.vid_xai, maxMedia: 2 });
  check("  and with a media limit below what it generates", res.status === 400 && /generates 3 images and videos/.test(res.error ?? ""), res.error);
  res = await admin.post("/api/projects", { ...base, imageModelRowId: ids.models.chat, videoModelRowId: ids.models.vid_xai });
  check("a chat model cannot be the image model", res.status === 400 && /Image model: .*not marked/.test(res.error ?? ""), res.error);
  res = await admin.post("/api/projects", { ...base, managerModelRowId: ids.models.img_openai });
  check("an image model cannot be the manager model", res.status === 400 && /must be a chat model/.test(res.error ?? ""), res.error);
  res = await admin.post("/api/projects", { ...base, workflowId: "nope" });
  eq("an unknown workflow is refused", res.status, 400);
  res = await admin.post("/api/projects", { ...base, maxMedia: 25 });
  eq("a media limit over 24 is refused", res.status, 400);

  begin("Projects: a Reel run (workflow)");
  res = await admin.post("/api/projects", { ...base, imageModelRowId: ids.models.img_openai, videoModelRowId: ids.models.vid_xai, maxMedia: 5, maxParallel: 3 });
  check("the project is created", res.status === 201, res.error);
  const reel = res.data?.project;
  eq("it stores the models and the limit", [reel?.imageModelRowId, reel?.videoModelRowId, reel?.maxMedia], [ids.models.img_openai, ids.models.vid_xai, 5]);

  await mockReset();
  const started = Date.now();
  const run = await runProject(admin, reel.id);
  const seconds = Math.round((Date.now() - started) / 1000);
  const ev = run.events;
  const done = ev.find((e) => e.type === "done");
  check(`the run succeeds (${seconds} s)`, done?.status === "succeeded", ev.filter((e) => e.type === "error" || (e.type === "task" && e.error)));
  const plan = ev.find((e) => e.type === "plan");
  eq("the plan event carries each task's kind", plan?.tasks?.map((t) => t.kind), ["text", "text", "video", "video", "image", "text"]);
  eq("steps go to the agents with the matching role", plan?.tasks?.map((t) => t.agent), ["Clara", "Clara", "Vito", "Vito", "Dee", "Cody"]);

  const finished = Object.fromEntries(ev.filter((e) => e.type === "task" && e.status === "succeeded").map((e) => [e.seq, e]));
  eq("all six tasks succeed", Object.keys(finished).length, 6);
  check("task 2 was given the output of task 1", /\[deps:1\]/.test(finished[2]?.artifact ?? ""), finished[2]?.artifact);
  check("task 6 was given the output of task 1", /\[deps:1\]/.test(finished[6]?.artifact ?? ""), finished[6]?.artifact);
  check("task 1 had nothing to depend on", /\[deps:none\]/.test(finished[1]?.artifact ?? ""), finished[1]?.artifact);

  for (const seq of [3, 4]) {
    const asset = finished[seq]?.assets?.[0];
    eq(`task ${seq} delivers a ready video`, [asset?.kind, asset?.status, asset?.projectId, Boolean(asset?.taskId)], ["video", "ready", reel.id, true]);
    eq(`  with the step's options`, asset?.options, { aspectRatio: "9:16", durationSeconds: 6 });
    check(`  whose prompt is the agent's, cleaned of its wrapping`, /^A video of a lighthouse at dusk for 'Scene \d clip', warm light, slow camera push-in \[deps:2\]$/.test(asset?.prompt ?? ""), asset?.prompt);
    check(`  and whose task output names the file and the prompt`, (finished[seq]?.artifact ?? "").includes(asset?.id ?? "?") && (finished[seq]?.artifact ?? "").includes("A video of a lighthouse"), finished[seq]?.artifact);
  }
  const cover = finished[5]?.assets?.[0];
  eq("task 5 delivers a ready image", [cover?.kind, cover?.status, cover?.options], ["image", "ready", { aspectRatio: "9:16" }]);
  check("  written from the outputs of tasks 1 and 2", /\[deps:1\+2\]$/.test(cover?.prompt ?? ""), cover?.prompt);
  eq("text tasks carry no assets", [finished[1]?.assets, finished[2]?.assets, finished[6]?.assets], [undefined, undefined, undefined]);

  const progress = ev.filter((e) => e.type === "progress");
  check("progress notes name the generator while a video is made", progress.some((e) => /Generating the video with vid-ok/.test(e.message)) && progress.some((e) => /\(\d+s\)/.test(e.message)), progress.map((e) => e.message));
  const running = (seq) => ev.find((e) => e.type === "task" && e.seq === seq && e.status === "running")?.at ?? 0;
  check("the two clips are generated in parallel", Math.abs(running(3) - running(4)) < 1500, [running(3), running(4)]);

  const log = await mockLog();
  const videoRequests = log.filter((r) => r.path === "/xai/v1/videos/generations");
  eq("two video requests, with the step's length and shape", videoRequests.map((r) => [r.body.duration, r.body.aspect_ratio]), [[6, "9:16"], [6, "9:16"]]);
  const imageRequest = log.find((r) => r.path === "/openai/v1/images/generations");
  eq("one image request, portrait", [imageRequest?.body?.size, imageRequest?.body?.n], ["1024x1536", undefined]);
  check("the final deliverable is written, and the manager is told media cannot be seen", /mentions-media=true/.test(ev.find((e) => e.type === "final")?.deliverable ?? ""), ev.find((e) => e.type === "final"));
  check("the review runs", /VERDICT: pass/.test(ev.find((e) => e.type === "review")?.notes ?? ""));

  const detail = (await admin.get(`/api/projects/${reel.id}`)).data?.project;
  eq("the stored tasks keep kind and options", detail?.tasks?.map((t) => [t.kind, t.media]), [
    ["text", null],
    ["text", null],
    ["video", { aspectRatio: "9:16", durationSeconds: 6 }],
    ["video", { aspectRatio: "9:16", durationSeconds: 6 }],
    ["image", { aspectRatio: "9:16" }],
    ["text", null],
  ]);
  const projectMedia = await admin.get(`/api/media?projectId=${reel.id}`);
  eq("the project's media: two videos and an image", projectMedia.data?.assets?.map((a) => a.kind).sort(), ["image", "video", "video"]);
  eq("another user cannot list a project's media", (await bob.get(`/api/media?projectId=${reel.id}`)).status, 403);

  begin("Projects: a second run keeps the earlier media");
  const rerun = await runProject(admin, reel.id);
  eq("the re-run succeeds", rerun.events.find((e) => e.type === "done")?.status, "succeeded");
  const after = (await admin.get(`/api/media?projectId=${reel.id}`)).data?.assets ?? [];
  eq("six files now belong to the project", after.length, 6);
  eq("  three of them from the run whose tasks are gone", after.filter((a) => a.taskId === null).length, 3);

  begin("Projects: AI-planned, images only");
  res = await admin.post("/api/projects", { title: "Poster", goal: "A poster and a teaser.", managerModelRowId: ids.models.chat, imageModelRowId: ids.models.img_openrouter });
  const poster = res.data?.project;
  await mockReset();
  let planned = await runProject(admin, poster.id);
  eq("the run succeeds", planned.events.find((e) => e.type === "done")?.status, "succeeded");
  eq("the manager's video task was not offered; its image task is kept", planned.events.find((e) => e.type === "plan")?.tasks?.map((t) => [t.title, t.kind]), [["Write the brief", "text"], ["Poster", "image"], ["Summary", "text"]]);
  let planRequest = (await mockLog()).find((r) => r.path.endsWith("/chat/completions") && /AI Manager of an engineering team/.test(r.body?.messages?.[0]?.content ?? ""));
  const planPrompt = planRequest?.body?.messages?.[0]?.content ?? "";
  check("the planning prompt offers images, not videos, and names the limit", /a generated image instead of text/.test(planPrompt) && !/"video"/.test(planPrompt) && /Use at most 10 such tasks/.test(planPrompt), planPrompt.slice(planPrompt.indexOf("Creative tasks")));
  const posterTask = planned.events.find((e) => e.type === "task" && e.seq === 2 && e.status === "succeeded");
  eq("the image keeps the valid option and drops the invalid one", posterTask?.assets?.[0]?.options, { aspectRatio: "3:4" });
  const posterRequest = (await mockLog()).find((r) => r.path === "/openrouter/api/v1/images");
  eq("  and is requested in the provider's style", posterRequest?.body?.aspect_ratio, "3:4");
  const summary = planned.events.find((e) => e.type === "task" && e.seq === 3 && e.status === "succeeded");
  check("a task that depends on the image is given its prompt, not the file", /\[deps:1\+2\]/.test(summary?.artifact ?? ""), summary?.artifact);
  const summaryRequest = (await mockLog()).find((r) => r.path.endsWith("/chat/completions") && /^Task: Summary/.test(r.body?.messages?.at(-1)?.content ?? ""));
  check("  with a note that agents cannot see it", /not visible to other agents/.test(summaryRequest?.body?.messages?.at(-1)?.content ?? ""), summaryRequest?.body?.messages?.at(-1)?.content);

  begin("Projects: AI-planned, no media models");
  res = await admin.post("/api/projects", { title: "Plain", goal: "A poster and a teaser.", managerModelRowId: ids.models.chat });
  await mockReset();
  planned = await runProject(admin, res.data?.project?.id);
  eq("the run succeeds", planned.events.find((e) => e.type === "done")?.status, "succeeded");
  eq("the image task the manager asked for anyway becomes a text task", planned.events.find((e) => e.type === "plan")?.tasks?.map((t) => t.kind), ["text", "text", "text"]);
  let logNow = await mockLog();
  eq("nothing is generated", logNow.filter((r) => /images|videos/.test(r.path)).length, 0);
  planRequest = logNow.find((r) => /AI Manager of an engineering team/.test(r.body?.messages?.[0]?.content ?? ""));
  check("the planning prompt does not mention creative tasks", !/Creative tasks/.test(planRequest?.body?.messages?.[0]?.content ?? ""));

  begin("Projects: AI-planned, media limit");
  res = await admin.post("/api/projects", { title: "Both, limit 1", goal: "A poster and a teaser.", managerModelRowId: ids.models.chat, imageModelRowId: ids.models.img_openai, videoModelRowId: ids.models.vid_openai, maxMedia: 1 });
  await mockReset();
  planned = await runProject(admin, res.data?.project?.id);
  eq("the run succeeds", planned.events.find((e) => e.type === "done")?.status, "succeeded");
  eq("only the first media task generates; the next one is delivered as text", planned.events.find((e) => e.type === "plan")?.tasks?.map((t) => [t.title, t.kind]), [["Write the brief", "text"], ["Poster", "image"], ["Teaser", "text"], ["Summary", "text"]]);
  logNow = await mockLog();
  eq("one image request and no video request", [logNow.filter((r) => r.path.endsWith("/images/generations")).length, logNow.filter((r) => r.path.endsWith("/videos")).length], [1, 0]);

  res = await admin.post("/api/projects", { title: "Both, limit 0", goal: "A poster and a teaser.", managerModelRowId: ids.models.chat, imageModelRowId: ids.models.img_openai, videoModelRowId: ids.models.vid_openai, maxMedia: 0 });
  await mockReset();
  planned = await runProject(admin, res.data?.project?.id);
  eq("with a limit of 0 every task is text", planned.events.find((e) => e.type === "plan")?.tasks?.map((t) => t.kind), ["text", "text", "text"]);
  eq("  and nothing is generated", (await mockLog()).filter((r) => /images|videos/.test(r.path)).length, 0);

  begin("Projects: a failing generator");
  res = await admin.post("/api/projects", { title: "Fails", goal: "A poster and a teaser.", managerModelRowId: ids.models.chat, imageModelRowId: ids.models["img-fail"] });
  planned = await runProject(admin, res.data?.project?.id);
  const failedTask = planned.events.find((e) => e.type === "task" && e.seq === 2 && e.status === "failed");
  check("the image task fails with the provider's reason and the prompt that was used", /safety system/.test(failedTask?.error ?? "") && /Prompt: A image of a lighthouse/.test(failedTask?.error ?? ""), failedTask?.error);
  const blocked = planned.events.find((e) => e.type === "task" && e.seq === 3 && e.status === "blocked");
  check("the task that needs it is blocked", Boolean(blocked), planned.events.filter((e) => e.type === "task").map((e) => [e.seq, e.status]));
  check("the run does not end as succeeded", planned.events.find((e) => e.type === "done")?.status !== "succeeded", planned.events.find((e) => e.type === "done"));

  begin("Projects: a model that became unusable");
  res = await admin.post("/api/projects", { ...base, title: "Reel, model disabled later", imageModelRowId: ids.models.img_openai, videoModelRowId: ids.models.vid_openrouter });
  const later = res.data?.project;
  await admin.patch(`/api/models/${ids.models.vid_openrouter}`, { enabled: false });
  await mockReset();
  planned = await runProject(admin, later.id);
  const stopped = planned.events.find((e) => e.type === "error");
  check("a workflow run stops before anything is spent", /no usable video model: Model is disabled/.test(stopped?.message ?? ""), stopped);
  eq("  no request reached the provider", (await mockLog()).length, 0);
  await admin.patch(`/api/models/${ids.models.vid_openrouter}`, { enabled: true });

  begin("Projects: cancelling while a video is generated");
  res = await admin.post("/api/projects", { ...base, title: "Reel, cancelled", imageModelRowId: ids.models.img_openai, videoModelRowId: ids.models["vid-slow"] });
  const slow = res.data?.project;
  let cancelSent = false;
  const cancelStarted = Date.now();
  planned = await runProject(admin, slow.id, {
    onEvent: async (event) => {
      if (!cancelSent && event.type === "progress" && /\(\d+s\)/.test(event.message)) {
        cancelSent = true;
        const c = await admin.post(`/api/projects/${slow.id}/cancel`);
        eq("cancel is accepted", c.status, 200);
      }
    },
  });
  check(`the run ends as cancelled (${Math.round((Date.now() - cancelStarted) / 1000)} s)`, planned.events.find((e) => e.type === "done")?.status === "cancelled", planned.events.at(-1));
  const cancelledTasks = planned.events.filter((e) => e.type === "task" && e.status === "failed" && /Cancelled while the video was being generated/.test(e.error ?? ""));
  eq("both clip tasks say they were cancelled", cancelledTasks.length, 2);
  eq("  and hand over the video that is still in progress", cancelledTasks.map((e) => e.assets?.[0]?.status), ["pending", "pending"]);
  const left = (await admin.get(`/api/media?projectId=${slow.id}`)).data?.assets ?? [];
  eq("the two videos stay in the library as pending", left.filter((a) => a.kind === "video").map((a) => a.status), ["pending", "pending"]);
  // The cover image was generated in the same wave, before the cancel.
  eq("  next to the cover image that was already made", left.filter((a) => a.kind === "image").map((a) => a.status), ["ready"]);
  for (const asset of left) await admin.del(`/api/media/${asset.id}`);

  begin("Projects: deleting a project keeps its media");
  const beforeDelete = (await admin.get(`/api/media?projectId=${reel.id}`)).data?.assets?.length;
  const deleted = await admin.del(`/api/projects/${reel.id}`);
  if (deleted.status === 200) {
    const mine = (await admin.get("/api/media")).data?.assets ?? [];
    const orphans = mine.filter((a) => a.kind === "video" && a.options?.durationSeconds === 6 && a.projectId === null);
    check("its media stays in the owner's library, no longer tied to a project", orphans.length >= 4, { beforeDelete, orphans: orphans.length });
  } else {
    console.log(`       (projects cannot be deleted through the API: ${deleted.status})`);
  }

  return { reelId: later.id, posterId: poster.id };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

async function pages({ posterId }) {
  begin("Pages render on the server");
  async function page(user, path) {
    const res = await user.raw(path);
    return { status: res.status, html: await res.text(), location: res.headers.get("location") };
  }
  const studio = await page(admin, "/dashboard/studio");
  check("Creative Studio", studio.status === 200 && studio.html.includes("Creative Studio") && studio.html.includes("Library"), studio.status);
  check("  offers the image models with their provider", studio.html.includes("Mock Image · Mock OpenAI-style"));
  check("  shows the stored media", studio.html.includes("/api/media/") && studio.html.includes("/file"));
  check("  has the navigation entry", studio.html.includes('href="/dashboard/studio"'));
  const projectStudio = await page(admin, `/dashboard/studio?project=${posterId}`);
  check("Creative Studio for one project", projectStudio.status === 200 && projectStudio.html.includes("generated by the project") && projectStudio.html.includes("Poster"), projectStudio.status);
  const foreign = await page(bob, `/dashboard/studio?project=${posterId}`);
  check("  another user gets their own library instead", foreign.status === 200 && !foreign.html.includes("generated by the project"), foreign.status);
  const bobStudio = await page(bob, "/dashboard/studio");
  check("  an ordinary user sees no \"Everyone's\" switch", bobStudio.status === 200 && !bobStudio.html.includes("Everyone&#x27;s") && studio.html.includes("Everyone&#x27;s"));

  const chat = await page(admin, "/dashboard/chat");
  check("Chat lists chat models only", chat.status === 200 && chat.html.includes("chat-mini") && !chat.html.includes("vid-ok") && !chat.html.includes("Mock Image"), chat.status);
  const agents = await page(admin, "/dashboard/agents");
  check("Agents renders", agents.status === 200 && agents.html.includes("Clara"), agents.status);
  const projects = await page(admin, "/dashboard/projects");
  check("AI Manager renders", projects.status === 200 && projects.html.includes("Poster"), projects.status);
  const project = await page(admin, `/dashboard/projects/${posterId}`);
  check("a project with media renders, with its image", project.status === 200 && project.html.includes("/api/media/") && project.html.includes("images: img-ok"), project.status);
  const models = await page(admin, "/dashboard/models");
  check("Models shows media prices", models.status === 200 && models.html.includes("/image") && models.html.includes("/second"), models.status);
  const workflows = await page(admin, "/dashboard/workflows");
  check("Workflows shows what a workflow generates", workflows.status === 200 && workflows.html.includes("2 videos · 1 image"), workflows.status);
  const providers = await page(admin, "/dashboard/providers");
  check("Providers renders", providers.status === 200 && providers.html.includes("Mock xAI"), providers.status);
  const usage = await page(admin, "/dashboard/usage");
  check("Usage renders", usage.status === 200, usage.status);
  const overview = await page(admin, "/dashboard");
  check("Overview renders", overview.status === 200, overview.status);
  const signedOut = await page(anon, "/dashboard/studio");
  check("signed out: sent to the sign-in page", signedOut.status === 307 && (signedOut.location ?? "").includes("/login"), [signedOut.status, signedOut.location]);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const steps = { images, videos, library, limits };
try {
  await setup();
  for (const [name, step] of Object.entries(steps)) {
    if (!ONLY || ONLY.has(name)) await step();
  }
  if (!ONLY || ONLY.has("projects")) {
    const made = await projects();
    await pages(made);
  }
} catch (err) {
  failures.push(`${section}: the run stopped: ${err?.stack ?? err}`);
  console.log(`  FAIL the run stopped: ${err?.stack ?? err}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
