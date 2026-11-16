// End-to-end checks of what runs in the background and around it: speech,
// joined videos, the knowledge base, agent tools and memory, runs that go on
// without a page, schedules, notifications, the public API, and the
// Anthropic, Gemini and custom HTTP adapters. Called by checks.mjs, which owns
// the accounts, the providers and the test harness.
//
// Like the rest: this runs against the mock in mock-provider.mjs, which is
// written from the providers' public documentation. Passing here shows the
// app is consistent with that reading; it is not a test against the real
// services.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reelWorkflowTemplate, templateNeeds } from "../../src/lib/creative/templates.ts";
import { SKILL_UPLOAD_MAX_BYTES } from "../../src/lib/skills/limits.ts";
import { readZip, writeZip } from "../../src/lib/skills/zip.ts";

export const AUTOMATION_PARTS = ["speech", "render", "knowledge", "tools", "skills", "runs", "notifications", "api", "adapters", "reel", "accounts", "health", "tokens"];

const CDN = process.env.E2E_CDN_URL ?? "http://127.0.0.1:4011";
const DB_PATH = process.env.E2E_DB_PATH;
const HAS_FFMPEG = process.env.E2E_FFMPEG === "1";
const FFMPEG = process.env.E2E_FFMPEG_PATH || "ffmpeg";
const GEMINI_KEY = "AIzaSyMOCK-0123456789-not-a-real-key";
const ANTHROPIC_KEY = "sk-ant-mock-0123456789abcdefghijklmnopqrstuvwxyz";

/** A minimal, valid PDF with text on its pages. */
function makePdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = 1 + pages.length * 2 + 1;
  const pageIds = [];
  for (const lines of pages) {
    const text = lines
      .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 18} Td (${line.replace(/([()\\])/g, "\\$1")}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`),
    );
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export async function automation(ctx) {
  const { APP, MOCK, KEY, only, admin, bob, carol, ids, begin, check, eq, sleep, mockLog, mockReset, mediaFiles, settle, runProject, client } = ctx;
  const wants = (part) => !only || only.has(part);
  const state = { models: {}, agents: {} };

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** A request whose answer is a stream of events; resolves when the stream ends. */
  async function sse(user, path, { method = "GET", body } = {}) {
    const res = await user.raw(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const events = [];
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("event-stream")) {
      return { status: res.status, events, text: await res.text() };
    }
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      try {
        events.push(JSON.parse(payload));
      } catch {
        events.push(payload);
      }
    }
    return { status: res.status, events, text };
  }

  /** Upload a file as the body of a request. */
  async function upload(user, path, bytes, name, type = "application/octet-stream") {
    const res = await user.raw(path, {
      method: "POST",
      body: bytes,
      headers: { "content-type": type, "x-file-name": encodeURIComponent(name) },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, data, error: data?.error?.message ?? null };
  }

  /** Ask again until `done(value)` holds. Resolves to the last value. */
  async function until(read, done, { tries = 30, gapMs = 1000 } = {}) {
    let value;
    for (let i = 0; i < tries; i++) {
      value = await read();
      if (done(value)) return value;
      await sleep(gapMs);
    }
    return value;
  }

  /** The app's database, for the few checks that have to set a time or a state by hand. */
  function database() {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(DB_PATH);
    db.pragma("busy_timeout = 5000");
    return db;
  }

  /** The public API, with a key. */
  async function v1(path, { key, method = "GET", body, headers = {} } = {}) {
    return fetch(`${APP}/api/v1${path}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  async function v1json(path, init) {
    const res = await v1(path, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, data, error: data?.error ?? null, headers: res.headers };
  }

  async function model(key, provider, modelId, capabilities, extra = {}) {
    const res = await admin.post("/api/models", { providerId: provider, modelId, capabilities, ...extra });
    if (res.status !== 201) check(`model ${key} is created`, false, res.error);
    state.models[key] = res.data?.model?.id;
    return res.data?.model;
  }

  async function agent(name, role, body = {}) {
    const res = await admin.post("/api/agents", { name, role, instructions: `You are the ${role}.`, primaryModelRowId: ids.models.chat, ...body });
    if (res.status !== 201) check(`agent ${name} is created`, false, res.error);
    state.agents[name] = res.data?.agent?.id;
    return res;
  }

  async function workflow(name, steps) {
    const res = await admin.post("/api/workflows", { name, steps });
    if (res.status !== 201) check(`workflow ${name} is created`, false, res.error);
    return res.data?.workflow?.id;
  }

  async function project(user, body) {
    const res = await user.post("/api/projects", { goal: "Check the app.", managerModelRowId: ids.models.chat, ...body });
    if (res.status !== 201) check(`project ${body.title} is created`, false, res.error);
    return res.data?.project?.id;
  }

  const finished = (events) => events.filter((e) => e.type === "task" && e.status !== "running");
  const taskOf = (events, seq) => finished(events).find((e) => e.seq === seq);

  // ─── Setup ─────────────────────────────────────────────────────────────────

  begin("Setup: speech, embedding and tool models");
  const openai = ids.providers.openai;
  const speechModel = await model("tts", openai, "tts-1", ["speech_generation"], { pricePerMChars: 15 });
  eq("a speech model stores its price per million characters", speechModel?.pricePerMChars, 15);
  for (const id of ["tts-pcm", "tts-fail", "tts-json", "tts-html"]) await model(id, openai, id, ["speech_generation"]);
  await model("embed", openai, "text-embedding-3-small", ["embeddings"], { inputPricePerMTok: 0.02 });
  await model("embed-fail", openai, "embed-fail", ["embeddings"]);
  await model("vid-real", openai, "vid-real", ["video_generation"], { pricePerSecond: 0.1 });
  await model("chat-notools", openai, "chat-notools", ["text"]);
  check("the models are created", Object.values(state.models).every(Boolean), state.models);

  const listed = await admin.get("/api/models");
  const kinds = new Map((listed.data?.models ?? []).map((m) => [m.modelId, m.capabilities.map((c) => c.capability)]));
  eq("an embedding model is no chat model", kinds.get("text-embedding-3-small"), ["embeddings"]);
  const chatWithEmbedding = await admin.post("/api/chat", { modelRowId: state.models.embed, messages: [{ role: "user", content: "hi" }] });
  check("  chat refuses it", chatWithEmbedding.status === 400 && /not a chat model/.test(chatWithEmbedding.error ?? ""), chatWithEmbedding.error);
  const agentWithSpeech = await admin.post("/api/agents", { name: "Wrong", role: "Wrong", primaryModelRowId: state.models.tts });
  eq("  a speech model cannot be an agent's model", agentWithSpeech.status, 400);

  // ─── Speech ────────────────────────────────────────────────────────────────

  const made = {};
  async function speech() {
    begin("Speech: text to a stored voice-over");
    await mockReset();
    const filesBefore = (await mediaFiles()).length;
    const text = "Hello from Pekanbaru. This is a short test of the voice, twenty words long so that it lasts one second.";
    const res = await admin.post("/api/media/speech", { modelRowId: state.models.tts, text, voice: "alloy", speed: 1.25 });
    eq("the request is accepted", res.status, 201);
    const a = res.data?.asset;
    made.speech = a;
    eq("it is stored as audio, ready at once", [a?.kind, a?.status, a?.source, a?.mimeType], ["audio", "ready", "provider", "audio/wav"]);
    check("its length is read from the file", a?.durationSeconds > 0.9 && a?.durationSeconds < 1.1, a?.durationSeconds);
    eq("the voice and speed are kept with it", [a?.options?.voice, a?.options?.speed], ["alloy", 1.25]);
    check("the cost is the text's length times the price", Math.abs((a?.estimatedCost ?? 0) - (text.length * 15) / 1_000_000) < 1e-9, a?.estimatedCost);
    const log = await mockLog();
    eq("one request, to the speech endpoint, with the text and the voice", [log.length, log[0]?.path, log[0]?.body?.input, log[0]?.body?.voice, log[0]?.body?.speed], [1, "/openai/v1/audio/speech", text, "alloy", 1.25]);
    eq("the key goes to the provider", log[0]?.authorization, `Bearer ${KEY}`);

    const file = await admin.raw(a.url);
    const bytes = Buffer.from(await file.arrayBuffer());
    eq("the file is served as audio", [file.status, file.headers.get("content-type"), file.headers.get("x-content-type-options")], [200, "audio/wav", "nosniff"]);
    check("  and is the WAV the provider sent", bytes.subarray(0, 4).toString() === "RIFF" && bytes.length === a.sizeBytes, bytes.length);
    const part = await admin.raw(a.url, { headers: { range: "bytes=0-43" } });
    eq("  a player can ask for a part of it", [part.status, part.headers.get("content-range")], [206, `bytes 0-43/${a.sizeBytes}`]);
    await part.arrayBuffer();
    eq("another user cannot read it", (await bob.raw(a.url)).status, 403);
    const audioOnly = await admin.get("/api/media?kind=audio");
    check("the library lists it under ?kind=audio", audioOnly.data?.assets?.length >= 1 && audioOnly.data.assets.every((x) => x.kind === "audio"), audioOnly.data?.assets?.length);

    const pcm = await admin.post("/api/media/speech", { modelRowId: state.models["tts-pcm"], text: "Bare samples." });
    const pcmFile = Buffer.from(await (await admin.raw(pcm.data?.asset?.url ?? "/none")).arrayBuffer());
    check("bare samples from the provider are stored as a playable WAV file", pcm.status === 201 && pcm.data.asset.mimeType === "audio/wav" && pcmFile.subarray(0, 4).toString() === "RIFF" && pcmFile.subarray(8, 12).toString() === "WAVE", [pcm.status, pcm.error]);
    check("  with the length of the samples", Math.abs((pcm.data?.asset?.durationSeconds ?? 0) - 0.5) < 0.01, pcm.data?.asset?.durationSeconds);
    made.speechShort = pcm.data?.asset;

    begin("Speech: failures");
    const before = (await mediaFiles()).length;
    const rejected = await admin.post("/api/media/speech", { modelRowId: state.models["tts-fail"], text: "x" });
    check("a request the provider rejects is an error with its reason", rejected.status === 502 && /voice is not available/.test(rejected.error ?? ""), `${rejected.status} ${rejected.error}`);
    const disguised = await admin.post("/api/media/speech", { modelRowId: state.models["tts-json"], text: "x" });
    check("an error that came with a success status is an error", disguised.status === 502 && /Quota exceeded for speech/.test(disguised.error ?? ""), `${disguised.status} ${disguised.error}`);
    const html = await admin.post("/api/media/speech", { modelRowId: state.models["tts-html"], text: "x" });
    check("a file that is not audio is refused, whatever it claims to be", html.status === 502 && /not an MP3, WAV/.test(html.error ?? ""), `${html.status} ${html.error}`);
    eq("failed requests leave no file behind", (await mediaFiles()).length, before);
    eq("text over the limit is refused", (await admin.post("/api/media/speech", { modelRowId: state.models.tts, text: "x".repeat(4097) })).status, 400);
    eq("empty text is refused", (await admin.post("/api/media/speech", { modelRowId: state.models.tts, text: "   " })).status, 400);
    const wrong = await admin.post("/api/media/speech", { modelRowId: ids.models.chat, text: "x" });
    check("a chat model is not a speech model", wrong.status === 400 && /not marked for speech/.test(wrong.error ?? ""), wrong.error);
    eq("signed out: refused", (await ctx.anon.post("/api/media/speech", { modelRowId: state.models.tts, text: "x" })).status, 401);
    check("files were stored for the two that worked", (await mediaFiles()).length === filesBefore + 2, [(await mediaFiles()).length, filesBefore]);
  }

  // ─── Joining clips ─────────────────────────────────────────────────────────

  /** A finished video of the model that returns a real, playable clip. */
  /**
   * What a video file holds when it is played: frames of picture, and seconds
   * of sound. Decoded with ffmpeg, not read from the file's own description.
   */
  async function played(user, asset) {
    const folder = mkdtempSync(join(tmpdir(), "nexus-e2e-film-"));
    try {
      const file = join(folder, "film.mp4");
      writeFileSync(file, Buffer.from(await (await user.raw(asset.url)).arrayBuffer()));
      const decode = (stream) =>
        spawnSync(FFMPEG, ["-hide_banner", "-nostdin", "-i", file, "-map", stream, "-f", "null", "-"], { encoding: "utf8" }).stderr ?? "";
      const frames = [...decode("0:v:0").matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
      const time = [...decode("0:a:0").matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
      return {
        frames: frames === undefined ? null : Number(frames),
        sound: time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : null,
      };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  /** Old ffmpeg versions count the last, partly empty packet of sound whole: up to 0.05 s more. */
  const soundIs = (film, seconds) => film.sound !== null && Math.abs(film.sound - seconds) <= 0.05;

  async function realVideo(user, prompt) {
    const started = await user.post("/api/media/videos", { modelRowId: state.models["vid-real"], prompt, durationSeconds: 2, aspectRatio: "9:16" });
    if (started.status !== 201) return null;
    return (await settle(user, started.data.asset.id)).asset;
  }

  async function render() {
    begin("Joining clips: what this server can do");
    const caps = await admin.get("/api/media/capabilities");
    eq("the server says whether it can join clips", caps.data?.render?.available, HAS_FFMPEG);
    const pngBytes = Buffer.from(await (await fetch(`${CDN}/cdn/any.png`)).arrayBuffer());

    const up = await upload(admin, "/api/media/upload", pngBytes, "my photo.png", "image/png");
    eq("an image can be uploaded into the library", [up.status, up.data?.asset?.kind, up.data?.asset?.source, up.data?.asset?.prompt], [201, "image", "upload", "my photo.png"]);
    made.upload = up.data?.asset;
    const svg = await upload(admin, "/api/media/upload", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "x.png", "image/png");
    check("  an SVG named .png is refused: the type is read from the bytes", svg.status === 400 && /PNG, JPEG, GIF or WebP/.test(svg.error ?? ""), `${svg.status} ${svg.error}`);
    const empty = await upload(admin, "/api/media/upload", Buffer.alloc(0), "empty.png", "image/png");
    eq("  an empty file is refused", empty.status, 400);
    eq("  signed out: refused", (await upload(ctx.anon, "/api/media/upload", pngBytes, "x.png", "image/png")).status, 401);

    if (!made.speech) {
      const s = await admin.post("/api/media/speech", { modelRowId: state.models.tts, text: "One line of narration for the cut." });
      made.speech = s.data?.asset;
    }

    if (!HAS_FFMPEG) {
      const refused = await admin.post("/api/media/render", { clipIds: [made.upload.id] });
      check("without ffmpeg, joining says what is missing", refused.status === 400 && /needs ffmpeg/.test(refused.error ?? ""), `${refused.status} ${refused.error}`);
      return;
    }

    begin("Joining clips: videos, a still, a voice-over, subtitles");
    const clipA = await realVideo(admin, "clip one");
    const clipB = await realVideo(admin, "clip two");
    check("two real clips are generated", clipA?.status === "ready" && clipB?.status === "ready", [clipA?.status, clipB?.status]);
    made.clips = [clipA, clipB];

    const started = await admin.post("/api/media/render", {
      clipIds: [clipA.id, made.upload.id, clipB.id],
      narrationIds: [made.speech.id],
      subtitles: true,
      aspectRatio: "9:16",
      title: "My cut",
    });
    eq("the request answers at once, with the video in progress", [started.status, started.data?.asset?.kind, started.data?.asset?.source, started.data?.asset?.status, started.data?.asset?.prompt], [201, "video", "render", "pending", "My cut"]);
    const renderId = started.data?.asset?.id;
    const done = await until(
      async () => (await admin.get(`/api/media/${renderId}`)).data?.asset,
      (a) => a?.status !== "pending",
      { tries: 90, gapMs: 1000 },
    );
    eq("the background worker makes the file", [done?.status, done?.mimeType, done?.error], ["ready", "video/mp4", null]);
    // Two clips of 2 s and a still of 4 s; the voice-over is shorter than that.
    eq("its length is the clips' and the still's together", done?.durationSeconds, 8);
    const film = await played(admin, done);
    check("  and the file holds just that: 240 frames of picture at 30 a second, and sound to the end", film.frames === 240 && soundIs(film, 8), film);
    const file = await admin.raw(done.url, { headers: { range: "bytes=0-11" } });
    const head = Buffer.from(await file.arrayBuffer());
    eq("the file is an MP4, served like any other video", [file.status, head.subarray(4, 8).toString()], [206, "ftyp"]);
    check("it costs nothing: no provider was asked", done.estimatedCost == null, done.estimatedCost);
    const bell = await admin.get("/api/notifications");
    check("its owner is told when it is ready", bell.data?.notifications?.some((n) => n.title === "Your joined video is ready"), bell.data?.notifications?.map((n) => n.title));
    made.render = done;

    const paired = await admin.post("/api/media/render", { clipIds: [clipA.id, clipB.id], narrationIds: [made.speech.id, made.speechShort?.id ?? made.speech.id], fit: "cover" });
    const pairedDone = await until(async () => (await admin.get(`/api/media/${paired.data?.asset?.id}`)).data?.asset, (a) => a?.status !== "pending", { tries: 90 });
    eq("one voice-over per clip: each plays over its own clip, and nothing is stretched when the clips are longer", [pairedDone?.status, pairedDone?.durationSeconds], ["ready", 4]);

    // Sixty words: the mock speaks them in three seconds, which is longer than the clip they go with.
    const long = await admin.post("/api/media/speech", { modelRowId: state.models.tts, text: `${Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(" ")}.` });
    const held = await admin.post("/api/media/render", { clipIds: [clipA.id, clipB.id], narrationIds: [long.data?.asset?.id, made.speechShort?.id ?? made.speech.id], keepClipAudio: true });
    const heldDone = await until(async () => (await admin.get(`/api/media/${held.data?.asset?.id}`)).data?.asset, (a) => a?.status !== "pending", { tries: 90 });
    // The first clip: 0.15 s, the 3 s of its voice-over, 0.35 s. The second: its own 2 s.
    eq("a clip under a longer voice-over lasts until the voice has ended", [long.data?.asset?.durationSeconds, heldDone?.status, heldDone?.error, heldDone?.durationSeconds], [3, "ready", null, 5.5]);
    const heldFilm = heldDone?.status === "ready" ? await played(admin, heldDone) : {};
    check("  its last frame is held: the picture is as long as the sound, with the clips' own sound kept under the voices", heldFilm.frames === 165 && soundIs(heldFilm, 5.5), heldFilm);

    begin("Joining clips: what is refused");
    const none = await admin.post("/api/media/render", { clipIds: [] });
    eq("no clips", none.status, 400);
    const foreign = await bob.post("/api/media/render", { clipIds: [clipA.id] });
    check("someone else's clip: as if it did not exist", foreign.status === 400 && /was not found/.test(foreign.error ?? ""), `${foreign.status} ${foreign.error}`);
    const audioAsClip = await admin.post("/api/media/render", { clipIds: [made.speech.id] });
    check("a voice-over as a clip", audioAsClip.status === 400 && /cannot be used as a clip/.test(audioAsClip.error ?? ""), audioAsClip.error);
    const clipAsVoice = await admin.post("/api/media/render", { clipIds: [clipA.id], narrationIds: [clipB.id] });
    check("a video as a voice-over", clipAsVoice.status === 400 && /cannot be used as a voice-over/.test(clipAsVoice.error ?? ""), clipAsVoice.error);
    const slow = await admin.post("/api/media/videos", { modelRowId: ids.models["vid-slow"], prompt: "never finishes" });
    const pending = await admin.post("/api/media/render", { clipIds: [slow.data?.asset?.id] });
    check("a video that is not finished", pending.status === 400 && /not finished/.test(pending.error ?? ""), pending.error);
    await admin.del(`/api/media/${slow.data?.asset?.id}`);
    eq("more clips than the limit", (await admin.post("/api/media/render", { clipIds: Array.from({ length: 41 }, () => clipA.id) })).status, 400);
    // The stand-in "video" of the other models is not a video at all: ffmpeg cannot read it.
    const fake = await admin.post("/api/media/videos", { modelRowId: ids.models["vid-instant"], prompt: "not a real video" });
    const fakeReady = fake.data?.asset?.status === "ready" ? fake.data.asset : (await settle(admin, fake.data?.asset?.id)).asset;
    const broken = await admin.post("/api/media/render", { clipIds: [fakeReady.id] });
    const brokenDone = await until(async () => (await admin.get(`/api/media/${broken.data?.asset?.id}`)).data?.asset, (a) => a?.status !== "pending", { tries: 60 });
    check("a clip ffmpeg cannot read: the result fails with the reason, and no file is left", brokenDone?.status === "failed" && /could not read one of the clips/.test(brokenDone?.error ?? "") && brokenDone.url === null, [brokenDone?.status, brokenDone?.error]);
    const leftovers = (await mediaFiles()).filter((name) => name.includes(broken.data?.asset?.id ?? "none"));
    eq("  nothing of it is in the media folder", leftovers, []);
  }

  // ─── Knowledge ─────────────────────────────────────────────────────────────

  async function knowledge() {
    begin("Knowledge: collections and documents");
    await mockReset();
    const created = await admin.post("/api/knowledge", { name: "Shop handbook", description: "How the shop works", visibility: "shared", embeddingModelRowId: state.models.embed });
    eq("a shared collection with an embedding model", [created.status, created.data?.collection?.visibility, created.data?.collection?.embeddingModelLabel], [201, "shared", "text-embedding-3-small"]);
    const col = created.data?.collection?.id;
    made.collection = col;
    const notEmbedding = await admin.post("/api/knowledge", { name: "Wrong", embeddingModelRowId: ids.models.chat });
    check("a chat model is not an embedding model", notEmbedding.status === 400 && /not marked for embeddings/.test(notEmbedding.error ?? ""), notEmbedding.error);

    const doc = await admin.post(`/api/knowledge/${col}/documents`, {
      title: "Refund policy",
      text: "Refund policy. Returns are accepted within 30 days of delivery when the item is unused. Refunds go back to the original payment method within five working days.\n\nShipping. Orders ship from Pekanbaru on weekdays. Delivery inside Sumatra takes two to four days.",
    });
    eq("pasted text becomes a document, searchable at once", [doc.status, doc.data?.document?.sourceType, doc.data?.document?.chunkCount, doc.data?.document?.embeddingStatus], [201, "text", 1, "pending"]);
    const early = await admin.post("/api/knowledge/search", { query: "refund", collectionIds: [col] });
    check("  by its words, before it is embedded", early.data?.hits?.[0]?.documentTitle === "Refund policy" && early.data.hits[0].matched.includes("text"), early.data?.hits);

    const link = await admin.post(`/api/knowledge/${col}/documents`, { url: `${CDN}/site/moved` });
    eq("a link: the page is fetched (through a redirect) and its title used", [link.status, link.data?.document?.title, link.data?.document?.sourceType, link.data?.document?.sourceName], [201, "The lighthouse keepers", "url", `${CDN}/site/article.html`]);
    const page = await admin.post("/api/knowledge/search", { query: "wick weather", collectionIds: [col] });
    const pageText = page.data?.hits?.find((h) => h.documentTitle === "The lighthouse keepers")?.content ?? "";
    check("  only what a reader sees is kept: no script, no style, entities decoded", pageText.includes("every four hours & logged") && !pageText.includes("document.title") && !pageText.includes("color:red"), pageText);
    const metadata = await admin.post(`/api/knowledge/${col}/documents`, { url: "http://169.254.169.254/latest/meta-data/" });
    check("a link into a private network is refused", metadata.status === 400 && /private network/.test(metadata.error ?? ""), `${metadata.status} ${metadata.error}`);
    const hop = await admin.post(`/api/knowledge/${col}/documents`, { url: `${CDN}/site/to-metadata` });
    check("  also when a public page redirects there", hop.status === 400 && /private network/.test(hop.error ?? ""), `${hop.status} ${hop.error}`);
    const binary = await admin.post(`/api/knowledge/${col}/documents`, { url: `${CDN}/site/binary.bin` });
    check("a link to something that is not text is refused", binary.status === 400 && /not text/.test(binary.error ?? ""), `${binary.status} ${binary.error}`);
    const gone = await admin.post(`/api/knowledge/${col}/documents`, { url: `${CDN}/site/missing` });
    check("a link that answers 404 is an error", gone.status === 502 && /404/.test(gone.error ?? ""), `${gone.status} ${gone.error}`);

    const pdf = await upload(admin, `/api/knowledge/${col}/documents/upload`, makePdf([["Warranty", "Every lamp has a two year warranty against defects."], ["Repairs", "Send the lamp back in its box."]]), "Warranty terms.pdf", "application/pdf");
    eq("a PDF: its text is read, page after page", [pdf.status, pdf.data?.document?.title, pdf.data?.document?.mimeType, pdf.data?.document?.sourceName], [201, "Warranty terms", "application/pdf", "Warranty terms.pdf"]);
    const md = await upload(admin, `/api/knowledge/${col}/documents/upload`, Buffer.from("# Opening hours\n\nThe shop is open from nine to five on weekdays.\n"), "hours.md", "text/markdown");
    eq("a Markdown file", [md.status, md.data?.document?.mimeType], [201, "text/markdown"]);
    const exe = await upload(admin, `/api/knowledge/${col}/documents/upload`, Buffer.from([0x4d, 0x5a, 0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0xff, 0xfe]), "tool.exe");
    check("a program is refused", exe.status === 400 && /not text/.test(exe.error ?? ""), `${exe.status} ${exe.error}`);
    const scan = await upload(admin, `/api/knowledge/${col}/documents/upload`, makePdf([[]]), "scan.pdf", "application/pdf");
    check("a PDF without text says that it is probably a scan", scan.status === 400 && /scan/.test(scan.error ?? ""), `${scan.status} ${scan.error}`);
    const big = await upload(admin, `/api/knowledge/${col}/documents/upload`, Buffer.alloc(15 * 1024 * 1024 + 1, 0x61), "big.txt", "text/plain");
    eq("a file over 15 MB is refused", big.status, 413);

    begin("Knowledge: embedding in the background, search by words and by meaning");
    const settled = await until(
      async () => (await admin.get(`/api/knowledge/${col}`)).data,
      (d) => d?.documents?.every((x) => x.embeddingStatus !== "pending"),
      { tries: 40, gapMs: 1000 },
    );
    eq("the worker embeds every document", settled?.documents?.map((d) => d.embeddingStatus).sort(), ["ready", "ready", "ready", "ready"]);
    eq("the collection counts its documents", [settled?.collection?.documentCount, settled?.collection?.chunkCount >= 4], [4, true]);
    const log = await mockLog();
    const embedCalls = log.filter((l) => l.path === "/openai/v1/embeddings");
    check("the texts went to the embedding model", embedCalls.length >= 1 && embedCalls.every((l) => l.body?.model === "text-embedding-3-small" && Array.isArray(l.body.input)), embedCalls.length);
    const found = await admin.post("/api/knowledge/search", { query: "how long do I have to return an item", collectionIds: [col] });
    eq("a question finds the passage that answers it", found.data?.hits?.[0]?.documentTitle, "Refund policy");
    check("  found by its words and by its meaning", found.data?.hits?.[0]?.matched?.includes("text") && found.data.hits[0].matched.includes("meaning"), found.data?.hits?.[0]?.matched);
    const limited = await admin.post("/api/knowledge/search", { query: "lamp warranty repairs shop", collectionIds: [col], limit: 2 });
    eq("  no more passages than asked for", limited.data?.hits?.length, 2);
    eq("an empty question is refused", (await admin.post("/api/knowledge/search", { query: " ", collectionIds: [col] })).status, 400);

    begin("Knowledge: who can do what");
    const bobList = await bob.get("/api/knowledge");
    check("another user sees the shared collection", bobList.data?.collections?.some((c) => c.id === col && !c.canManage && !c.owner), bobList.data?.collections);
    eq("  can search it", (await bob.post("/api/knowledge/search", { query: "refund", collectionIds: [col] })).data?.hits?.[0]?.documentTitle, "Refund policy");
    eq("  cannot add to it", (await bob.post(`/api/knowledge/${col}/documents`, { title: "x", text: "y" })).status, 403);
    eq("  cannot change it", (await bob.patch(`/api/knowledge/${col}`, { name: "Mine now" })).status, 403);
    eq("  cannot delete it", (await bob.del(`/api/knowledge/${col}`)).status, 403);
    const priv = await bob.post("/api/knowledge", { name: "Bob's notes" });
    eq("a user's own collection is private, searched by its words", [priv.status, priv.data?.collection?.visibility, priv.data?.collection?.embeddingModelRowId], [201, "private", null]);
    const bobCol = priv.data?.collection?.id;
    await bob.post(`/api/knowledge/${bobCol}/documents`, { title: "Secret plan", text: "The surprise party is on Friday." });
    const carolList = await carol.get("/api/knowledge");
    check("a third user does not see it", !carolList.data?.collections?.some((c) => c.id === bobCol), carolList.data?.collections?.map((c) => c.name));
    eq("  and cannot open it: as if it did not exist", (await carol.get(`/api/knowledge/${bobCol}`)).status, 404);
    eq("  nor search it", (await carol.post("/api/knowledge/search", { query: "party", collectionIds: [bobCol] })).status, 404);
    const mixed = await carol.post("/api/knowledge/search", { query: "party refund", collectionIds: [bobCol, col] });
    check("  asked together with one she can read, only that one is searched", mixed.status === 200 && mixed.data.hits.every((h) => h.collectionId === col), mixed.data?.hits?.map((h) => h.documentTitle));
    eq("signed out: refused", (await ctx.anon.get("/api/knowledge")).status, 401);

    begin("Knowledge: in chat");
    const chat = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: ids.models.chat, messages: [{ role: "user", content: "What is the warranty on lamps?" }], collectionIds: [col] } });
    const sources = chat.events.find((e) => e.sources)?.sources;
    eq("the passages that fit the question are looked up, the best one first", sources?.[0]?.documentTitle, "Warranty terms");
    const answer = chat.events.filter((e) => e.delta).map((e) => e.delta).join("");
    check("  and put in front of the model", answer.startsWith("From your documents [1]: Warranty terms (Shop handbook)"), answer);
    const off = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: ids.models.chat, messages: [{ role: "user", content: "Reply with the single word: ok" }] } });
    check("without a collection, chat is as before", !off.events.some((e) => e.sources) && off.events.filter((e) => e.delta).map((e) => e.delta).join("") === "ok", off.events);
    const foreign = await sse(carol, "/api/chat", { method: "POST", body: { modelRowId: ids.models.chat, messages: [{ role: "user", content: "When is the party?" }], collectionIds: [bobCol] } });
    check("someone else's private collection is not looked up", !foreign.events.some((e) => e.sources), foreign.events.find((e) => e.sources));

    begin("Knowledge: agents, changes, a failing embedding model");
    const onlyShared = await admin.post("/api/agents", { name: "Reader", role: "Reader", primaryModelRowId: ids.models.chat, collectionIds: [bobCol] });
    check("an agent cannot be given a private collection", onlyShared.status === 400 && /shared/.test(onlyShared.error ?? ""), `${onlyShared.status} ${onlyShared.error}`);
    const reader = await agent("Reader", "Reader", { collectionIds: [col] });
    eq("  it can be given a shared one", reader.data?.agent?.collectionIds, [col]);
    const lock = await admin.patch(`/api/knowledge/${col}`, { visibility: "private" });
    check("a collection an agent uses cannot be made private", lock.status === 400 && /agents/.test(lock.error ?? ""), `${lock.status} ${lock.error}`);

    const without = await admin.patch(`/api/knowledge/${col}`, { embeddingModelRowId: null });
    const dropped = (await admin.get(`/api/knowledge/${col}`)).data;
    eq("taking the model away drops the embeddings", [without.status, [...new Set(dropped?.documents?.map((d) => d.embeddingStatus))]], [200, ["none"]]);
    const wordsOnly = await admin.post("/api/knowledge/search", { query: "how long do I have to return an item", collectionIds: [col] });
    eq("  the collection is then searched by its words alone", wordsOnly.data?.hits?.[0]?.matched, ["text"]);
    await admin.patch(`/api/knowledge/${col}`, { embeddingModelRowId: state.models.embed });
    const again = await until(async () => (await admin.get(`/api/knowledge/${col}`)).data, (d) => d?.documents?.every((x) => x.embeddingStatus === "ready"), { tries: 40 });
    eq("giving it back embeds every document again", [...new Set(again?.documents?.map((d) => d.embeddingStatus))], ["ready"]);

    const failing = await admin.post("/api/knowledge", { name: "Failing", embeddingModelRowId: state.models["embed-fail"] });
    const failDoc = await admin.post(`/api/knowledge/${failing.data?.collection?.id}/documents`, { title: "Still here", text: "This document stays searchable by its words." });
    const failed = await until(async () => (await admin.get(`/api/knowledge/${failing.data?.collection?.id}`)).data?.documents?.[0], (d) => d?.embeddingStatus === "failed", { tries: 30 });
    check("when the embedding model fails, the document says so", failed?.embeddingStatus === "failed" && /embedding service is down/.test(failed?.error ?? ""), [failed?.embeddingStatus, failed?.error]);
    eq("  and is still found by its words", (await admin.post("/api/knowledge/search", { query: "searchable", collectionIds: [failing.data?.collection?.id] })).data?.hits?.[0]?.documentTitle, "Still here");
    check("  (the document was accepted)", failDoc.status === 201, failDoc.error);
    await admin.del(`/api/knowledge/${failing.data?.collection?.id}`);

    const removed = await admin.del(`/api/knowledge/${col}/documents/${md.data?.document?.id}`);
    const after = await admin.post("/api/knowledge/search", { query: "opening hours nine to five", collectionIds: [col] });
    check("a removed document is no longer found", removed.status === 200 && !after.data?.hits?.some((h) => h.documentTitle === "hours"), after.data?.hits?.map((h) => h.documentTitle));
    await bob.del(`/api/knowledge/${bobCol}`);
    eq("a deleted collection is gone", (await bob.get(`/api/knowledge/${bobCol}`)).status, 404);
  }

  // ─── Agent tools and memory ────────────────────────────────────────────────

  async function tools() {
    begin("Agent tools: what the server is set up for");
    const setup = await admin.get("/api/agents/tools");
    eq("the sandbox and the search service are configured", [setup.data?.sandbox, setup.data?.search], [true, "Brave Search"]);
    eq("every tool is available", setup.data?.tools?.filter((t) => !t.available).map((t) => t.name), []);
    if (!made.collection) {
      const c = await admin.post("/api/knowledge", { name: "Tools handbook", visibility: "shared" });
      made.collection = c.data?.collection?.id;
      await admin.post(`/api/knowledge/${made.collection}/documents`, { title: "Refund policy", text: "Refund policy. Returns are accepted within 30 days." });
    }
    const allTools = ["list_files", "read_file", "write_file", "edit_file", "delete_file", "run_command", "fetch_url", "http_request", "web_search"];
    const smith = await agent("Toolsmith", "Engineer", { tools: allTools, maxSteps: 8, memoryEnabled: true, collectionIds: [made.collection] });
    eq("an agent keeps its tools, its step limit, its memory setting and its collections", [smith.data?.agent?.tools, smith.data?.agent?.maxSteps, smith.data?.agent?.memoryEnabled, smith.data?.agent?.collectionIds], [allTools, 8, true, [made.collection]]);
    eq("an unknown tool is refused", (await admin.post("/api/agents", { name: "X", role: "X", tools: ["format_disk"] })).status, 400);
    eq("only an administrator gives agents tools", (await bob.patch(`/api/agents/${state.agents.Toolsmith}`, { tools: allTools })).status, 403);

    begin("Agent tools: a run where the agent works in steps");
    const wf = await workflow("Tools", [
      { title: "Tool: files", objective: "Write the plan file.", role: "Engineer" },
      { title: "Tool: web", objective: "Research.", role: "Engineer" },
      { title: "Tool: command", objective: "Run the check.", role: "Engineer" },
      { title: "Tool: forbidden", objective: "Try addresses it must not reach.", role: "Engineer" },
      { title: "Tool: knowledge", objective: "Look up the refund policy.", role: "Engineer" },
      { title: "Tool: memory", objective: "Keep a note.", role: "Engineer" },
      { title: "Tool: loop", objective: "Never stops by itself.", role: "Engineer" },
    ]);
    const projectId = await project(admin, { title: "Tools project", workflowId: wf, maxParallel: 4 });
    await mockReset();
    const run = await runProject(admin, projectId);
    eq("the run finishes", run.events.at(-1), { type: "done", status: "succeeded", at: run.events.at(-1)?.at });
    const calls = run.events.filter((e) => e.type === "tool").map((e) => `${e.seq}:${e.call.name}${e.call.isError ? "!" : ""}`);
    const of = (seq) => calls.filter((c) => c.startsWith(`${seq}:`)).map((c) => c.slice(2));

    const files = taskOf(run.events, 1);
    eq("files: written, read back, edited, listed, in that order", of(1), ["write_file", "read_file", "edit_file", "list_files", "read_file!"]);
    eq("  the task counts its steps and its tool calls", [files?.steps, files?.toolCalls], [5, 5]);
    check("  a path outside the workspace is refused, and the agent is told", /Path contains invalid characters|invalid/.test(files?.artifact ?? ""), files?.artifact);
    const ws = await admin.get(`/api/projects/${projectId}/workspace`);
    const wsFiles = ws.data?.files ?? [];
    check("  the file is in the project's workspace, as edited", wsFiles.some((f) => f.path === "notes/plan.md"), wsFiles.map((f) => f.path));
    const wsId = ws.data?.workspace?.id ?? ws.data?.id;
    const planFile = wsFiles.find((f) => f.path === "notes/plan.md");
    if (wsId && planFile) {
      const content = await admin.get(`/api/workspaces/${wsId}/files/${planFile.id}`);
      check("  with the edit applied", (content.data?.file?.content ?? content.data?.content ?? "").includes("Step one is done."), content.data);
    }

    const web = taskOf(run.events, 2);
    eq("web: searched, then read the first result", of(2), ["web_search", "fetch_url"]);
    check("  the page arrives as text, marked as coming from outside", /Content from outside/.test(web?.artifact ?? "") && /Title: The lighthouse keepers/.test(web.artifact) && !/document\.title/.test(web.artifact), web?.artifact);
    const log = await mockLog();
    const searchCall = log.find((l) => l.path.startsWith("/search/"));
    check("  the search went to the configured service", searchCall?.path.includes("q=lighthouse+keepers") && searchCall.path.includes("count=3"), searchCall?.path);

    const command = taskOf(run.events, 3);
    eq("command: the file is written, the program run in the sandbox", of(3), ["write_file", "run_command", "run_command!"]);
    const sandboxCalls = log.filter((l) => l.path === "/sandbox/run");
    eq("  the sandbox got the workspace files and one program", [sandboxCalls.length, sandboxCalls[0]?.body?.command, sandboxCalls[0]?.body?.files?.some((f) => f.path === "check.js"), sandboxCalls[0]?.authorization], [1, "node check.js", true, "Bearer sandbox-mock-token"]);
    check("  a command line with shell characters never reaches it", /Shell metacharacters/.test(command?.artifact ?? ""), command?.artifact);

    const forbidden = taskOf(run.events, 4);
    eq("forbidden: both requests are refused", of(4), ["fetch_url!", "http_request!"]);
    check("  the agent is told why", /private network/.test(forbidden?.artifact ?? ""), forbidden?.artifact);
    check("  nothing was sent to those addresses", !log.some((l) => l.path.includes("/admin") || l.path.includes("meta-data")), log.map((l) => l.path).filter((p) => /admin|meta/.test(p)));

    const lookup = taskOf(run.events, 5);
    eq("knowledge: the agent searches the collection it was given", of(5), ["search_knowledge"]);
    check("  and gets the passage, with where it is from", /\[1\] Refund policy/.test(lookup?.artifact ?? ""), lookup?.artifact);

    eq("memory: a note is kept, then found again", of(6), ["remember", "recall"]);
    check("  the note comes back", /prefers short sentences/.test(taskOf(run.events, 6)?.artifact ?? ""), taskOf(run.events, 6)?.artifact);

    const loop = taskOf(run.events, 7);
    eq("loop: the agent is stopped at its step limit", [loop?.status, loop?.steps, loop?.toolCalls], ["succeeded", 8, 7]);
    check("  after being told that it repeats itself", /three times in a row/.test(loop?.artifact ?? ""), loop?.artifact);

    begin("Agent tools: the record of what an agent did");
    const detail = await admin.get(`/api/projects/${projectId}`);
    const taskIds = detail.data?.project?.tasks?.map((t) => t.id) ?? [];
    eq("the project keeps the counts", detail.data?.project?.tasks?.map((t) => t.toolCalls), [5, 2, 3, 2, 1, 2, 7]);
    const trace = await admin.get(`/api/projects/${projectId}/tasks/${taskIds[3]}/tool-calls`);
    eq("each call is recorded with its result", trace.data?.calls?.map((c) => [c.name, c.isError]), [["fetch_url", true], ["http_request", true]]);
    check("  a credential the agent sent in a header is not kept", trace.data?.calls?.[1]?.arguments?.includes("(not kept)") && !trace.data.calls[1].arguments.includes("secret-token-value"), trace.data?.calls?.[1]?.arguments);
    eq("  another user cannot read it", (await bob.get(`/api/projects/${projectId}/tasks/${taskIds[3]}/tool-calls`)).status, 403);
    const attempts = (await admin.get(`/api/projects/${projectId}/attempts`)).data?.attempts ?? [];
    eq("each task's attempt is recorded, in the order of the tasks", attempts.map((a) => [a.seq, a.attempt, a.status]), [1, 2, 3, 4, 5, 6, 7].map((seq) => [seq, 1, "ok"]));
    check("  with the agent, the model and the provider that was asked", attempts.every((a) => a.agent === "Toolsmith" && a.model && a.modelId && a.provider && a.error === null), attempts[0]);
    eq("  and how many model calls and tool calls it took", attempts.map((a) => a.toolCalls), [5, 2, 3, 2, 1, 2, 7]);
    eq("  another user cannot read them", (await bob.get(`/api/projects/${projectId}/attempts`)).status, 403);

    begin("Agent memory: notes stay with the person whose project they are from");
    const notes = await admin.get(`/api/agents/${state.agents.Toolsmith}/memories`);
    eq("the note is listed for the agent", notes.data?.memories?.map((m) => [m.content, m.source, m.owner]), [["The client prefers short sentences and no exclamation marks.", "agent", "admin"]]);
    const plainWf = await workflow("Plain", [{ title: "Write a line", objective: "One line.", role: "Engineer" }]);
    const mine = await project(admin, { title: "Remembers", workflowId: plainWf });
    const mineRun = await runProject(admin, mine);
    check("in a later task of the same person, the agent has its notes", /\[with:notes\]/.test(taskOf(mineRun.events, 1)?.artifact ?? ""), taskOf(mineRun.events, 1)?.artifact);
    const theirs = await project(bob, { title: "Someone else's", workflowId: plainWf });
    const theirRun = await runProject(bob, theirs);
    check("in another person's project, it does not", theirRun.events.at(-1)?.status === "succeeded" && !/notes/.test(taskOf(theirRun.events, 1)?.artifact ?? ""), taskOf(theirRun.events, 1)?.artifact);
    eq("  and that person sees none of the notes", (await bob.get(`/api/agents/${state.agents.Toolsmith}/memories`)).data?.memories, []);
    eq("only an administrator adds a note for everyone", (await bob.post(`/api/agents/${state.agents.Toolsmith}/memories`, { content: "x" })).status, 403);
    const manual = await admin.post(`/api/agents/${state.agents.Toolsmith}/memories`, { content: "Prices are always in rupiah." });
    eq("an administrator's note applies to everyone", [manual.status, (await bob.get(`/api/agents/${state.agents.Toolsmith}/memories`)).data?.memories?.map((m) => [m.content, m.source, m.owner])], [201, [["Prices are always in rupiah.", "manual", null]]]);
    const theirSecond = await runProject(bob, theirs);
    check("  the other person's next task gets it", /\[with:notes\]/.test(taskOf(theirSecond.events, 1)?.artifact ?? ""), taskOf(theirSecond.events, 1)?.artifact);
    const noteId = notes.data?.memories?.[0]?.id;
    eq("a user cannot delete someone else's note", (await bob.del(`/api/agents/${state.agents.Toolsmith}/memories/${noteId}`)).status, 404);
    eq("its owner can", (await admin.del(`/api/agents/${state.agents.Toolsmith}/memories/${noteId}`)).status, 200);

    begin("Agent tools: a model that does not take tools");
    await agent("Fallback", "Fallbacker", { primaryModelRowId: state.models["chat-notools"], tools: ["list_files", "write_file"] });
    const fbWf = await workflow("No tools", [{ title: "Tool: files", objective: "Would use tools.", role: "Fallbacker" }]);
    const fb = await project(admin, { title: "No tools", workflowId: fbWf, managerModelRowId: ids.models.chat });
    const fbRun = await runProject(admin, fb);
    const fbTask = taskOf(fbRun.events, 1);
    check("the task is done without tools instead of failing", fbTask?.status === "succeeded" && /OUTPUT of "Tool: files"/.test(fbTask.artifact ?? "") && !fbTask.toolCalls, [fbTask?.status, fbTask?.artifact]);
    check("  and the run says so while it happens", fbRun.events.some((e) => e.type === "progress" && /did not accept tools/.test(e.message)), fbRun.events.filter((e) => e.type === "progress"));
    const fbAttempts = (await admin.get(`/api/projects/${fb}/attempts`)).data?.attempts ?? [];
    eq("  both attempts are recorded: the one that failed, and the one that answered", fbAttempts.map((a) => [a.attempt, a.status, a.modelId]), [[1, "error", "chat-notools"], [2, "ok", "chat-notools"]]);
    check("  the first with what the provider said", typeof fbAttempts[0]?.error === "string" && fbAttempts[0].error.length > 0 && fbAttempts[1]?.error === null, fbAttempts.map((a) => a.error));

    begin("Agent tools: a model that is limited keeps the agent its tools");
    await model("chat-limited", openai, "chat-limited", ["text"]);
    await agent("Limited", "Limitedworker", { primaryModelRowId: state.models["chat-limited"], fallbackModelRowId: ids.models.chat, tools: ["list_files", "write_file"] });
    const ltWf = await workflow("Limited", [{ title: "Tool: files", objective: "Uses tools.", role: "Limitedworker" }]);
    const lt = await project(admin, { title: "Limited", workflowId: ltWf, managerModelRowId: ids.models.chat });
    const ltRun = await runProject(admin, lt);
    const ltTask = taskOf(ltRun.events, 1);
    const ltAttempts = (await admin.get(`/api/projects/${lt}/attempts`)).data?.attempts ?? [];
    eq("\"too many requests\" is not taken for a refusal of tools: the next model is asked, with them", ltAttempts.map((a) => [a.attempt, a.status, a.modelId, a.toolCalls > 0]), [[1, "error", "chat-limited", false], [2, "ok", "chat-mini", true]]);
    check("  the task is done with its tools", ltTask?.status === "succeeded" && ltTask.toolCalls > 0, [ltTask?.status, ltTask?.toolCalls]);
    check("  and the run does not say that tools were turned down", !ltRun.events.some((e) => e.type === "progress" && /did not accept tools/.test(e.message)), ltRun.events.filter((e) => e.type === "progress"));
    check("  what the provider said is kept with the attempt", /Provider responded 429: .*Rate limit reached/.test(ltAttempts[0]?.error ?? ""), ltAttempts[0]?.error);

    begin("Agent tools: a task's output file, and what the reviewer is shown");
    await agent("Plainwriter", "Plain Writer");
    const outWf = await workflow("Output files", [
      { title: "Tool: output", objective: "Write the guide.", role: "Engineer", outputFile: "docs/guide.md" },
      { title: "Tool: silent", objective: "Write the notes, and say nothing.", role: "Engineer", outputFile: "docs/notes.md" },
      { title: "Fenced: data", objective: "Answer with the file.", role: "Plain Writer", outputFile: "data/pack.json" },
      { title: "Tool: files", objective: "Write the plan file.", role: "Engineer" },
      { title: "Write a line", objective: "One line.", role: "Plain Writer", outputFile: "docs/line.txt" },
    ]);
    const out = await project(admin, { title: "Output files", workflowId: outWf, managerModelRowId: ids.models.chat });
    await mockReset();
    const outRun = await runProject(admin, out);
    eq("the run finishes", outRun.events.at(-1)?.status, "succeeded");
    const outWs = await admin.get(`/api/projects/${out}/workspace`);
    const outWsId = outWs.data?.workspace?.id ?? outWs.data?.id;
    const contentOf = async (filePath) => {
      const file = (outWs.data?.files ?? []).find((f) => f.path === filePath);
      if (!file) return null;
      const got = await admin.get(`/api/workspaces/${outWsId}/files/${file.id}`);
      return got.data?.file?.content ?? got.data?.content ?? null;
    };
    const written = "# Written with the tool\n\nBy the agent, in the file.\n";
    const guide = taskOf(outRun.events, 1);
    eq("an agent that can write files is told to save its output file itself, and does", outRun.events.filter((e) => e.type === "tool" && e.seq === 1).map((e) => e.call.name), ["write_file"]);
    eq("  the file keeps what the agent saved, and not what it said afterwards", await contentOf("docs/guide.md"), written);
    check("  the task hands over the file, then what the agent said", (guide?.artifact ?? "").startsWith(`${written.trimEnd()}\n\n[Saved as docs/guide.md by the agent, which said: DONE after 1 tool results. LAST: Saved docs/guide.md (`), guide?.artifact);
    const silent = taskOf(outRun.events, 2);
    eq("an agent that saves its file and says nothing has done its task: the file is what it hands over", [silent?.status, silent?.artifact, await contentOf("docs/notes.md")], ["succeeded", written, written]);
    const fenced = taskOf(outRun.events, 3);
    eq("an answer that holds the file in a fence is saved without the fence and the words around it", await contentOf("data/pack.json"), '{"name": "from a fence"}\n');
    check("  the task still shows the whole answer", /^Here is the file:/.test(fenced?.artifact ?? "") && /I could not run it\.$/.test(fenced?.artifact ?? ""), fenced?.artifact);
    eq("an answer without a fence is saved as it is", await contentOf("docs/line.txt"), 'OUTPUT of "Write a line" [deps:none]');
    const outChats = (await mockLog()).filter((l) => l.path.endsWith("/chat/completions"));
    const outSystem = (title) => String(outChats.find((l) => String(l.body?.messages?.[1]?.content ?? "").startsWith(`Task: ${title}`))?.body?.messages?.[0]?.content ?? "");
    check("an agent without tools is told that its answer is the file", /Your answer is saved as the file data\/pack\.json: return the complete contents of that file and nothing else\./.test(outSystem("Fenced: data")) && !/You have tools/.test(outSystem("Fenced: data")), outSystem("Fenced: data").slice(-400));
    check("  one with tools and no output file is asked for the deliverable and a word on what it did", /answer with the deliverable itself and say briefly what you did/.test(outSystem("Tool: files")) && !/Your deliverable is the file/.test(outSystem("Tool: files")), outSystem("Tool: files").slice(-400));
    const outDetail = (await admin.get(`/api/projects/${out}`)).data?.project;
    check("the reviewer is shown the files that the deliverables only speak of", /\[files:notes\/plan\.md\]/.test(outDetail?.reviewNotes ?? ""), outDetail?.reviewNotes);
    check("  and is told which files each task wrote", /\[wrote:docs\/guide\.md;docs\/notes\.md;data\/pack\.json;notes\/plan\.md;docs\/line\.txt\]/.test(outDetail?.reviewNotes ?? ""), outDetail?.reviewNotes);
    const reviewAsk = outChats.find((l) => /QA\/Security reviewer/.test(String(l.body?.messages?.[0]?.content ?? "")));
    const reviewUser = String(reviewAsk?.body?.messages?.[1]?.content ?? "");
    check("  a file is shown as it is in the workspace, after the edit", /#### File: notes\/plan\.md \(\d+ characters\)\n# Plan\n\nStep one is done\./.test(reviewUser), reviewUser.slice(-600));
    check("  a file that a deliverable holds is not shown a second time", !/#### File: docs\/guide\.md/.test(reviewUser) && reviewUser.split("By the agent, in the file.").length - 1 === 2, reviewUser.slice(0, 900));
    check("  and that deliverable is said to be the file, so that the file is not taken for missing", /Deliverable \(it holds the file docs\/guide\.md, as saved in the workspace\):\n# Written with the tool/.test(reviewUser) && /Shown above, in the deliverable that holds it, and not again here: .*docs\/guide\.md/.test(reviewUser), reviewUser.slice(0, 600));
    const sumAsk = outChats.find((l) => /You are the AI Manager\. Consolidate/.test(String(l.body?.messages?.[0]?.content ?? "")));
    check("the manager is told that it works from the task outputs, and cannot open a file", /You work from the task outputs alone\./.test(String(sumAsk?.body?.messages?.[0]?.content ?? "")) && /Files in the project workspace:\n- data\/pack\.json \(\d+ characters\)/.test(String(sumAsk?.body?.messages?.[1]?.content ?? "")), String(sumAsk?.body?.messages?.[1]?.content ?? "").slice(-400));
    check("  and the reviewer is told what the files are", /After the tasks come the files of the project's workspace/.test(String(reviewAsk?.body?.messages?.[0]?.content ?? "")), String(reviewAsk?.body?.messages?.[0]?.content ?? "").slice(0, 700));
    check("the manager is given the files by name when it sums up", /files=5/.test(outDetail?.finalDeliverable ?? ""), outDetail?.finalDeliverable);

    begin("Projects: a reviewer whose first model does not answer");
    await model("chat-down", openai, "chat-down", ["text"]);
    await agent("Maker", "Maker");
    await agent("Checker", "Quality checker", { primaryModelRowId: state.models["chat-down"], fallbackModelRowId: ids.models.chat });
    const reviewed = await admin.post("/api/teams", { name: "Reviewed", agentIds: [state.agents.Maker, state.agents.Checker] });
    const reviewedWf = await workflow("Reviewed", [{ title: "Make", objective: "Make it.", role: "Maker" }]);
    const reviewedProject = await project(admin, { title: "Reviewed", workflowId: reviewedWf, teamId: reviewed.data?.team?.id });
    await mockReset();
    const reviewedRun = await runProject(admin, reviewedProject);
    const reviewAsked = (await mockLog())
      .filter((l) => l.path.endsWith("/chat/completions") && /QA\/Security reviewer/.test(String(l.body?.messages?.[0]?.content ?? "")))
      .map((l) => l.body?.model);
    eq("the review is asked of its first model, then of its second", reviewAsked, ["chat-down", "chat-mini"]);
    check("  and is written", /VERDICT: pass/.test(reviewedRun.events.find((e) => e.type === "review")?.notes ?? ""), reviewedRun.events.filter((e) => e.type === "review"));
    eq("  the project ends as done", (await admin.get(`/api/projects/${reviewedProject}`)).data?.project?.status, "succeeded");
    // Taken out again: the projects below have no reviewer among their agents, and are reviewed by their manager model.
    eq("  (that reviewer is deleted again)", (await admin.del(`/api/agents/${state.agents.Checker}`)).status, 200);
  }

  // ─── Runs in the background ────────────────────────────────────────────────

  async function runs() {
    begin("Runs: they go on without the page that started them");
    await agent("Scribe", "Scribe");
    await agent("Clipper", "Clipper");
    const wf = await workflow("Detach", [
      { title: "Script", objective: "Write.", role: "Scribe" },
      { title: "Clip", objective: "A clip.", role: "Clipper", kind: "video", media: { durationSeconds: 4 }, dependsOn: [1] },
      { title: "Wrap", objective: "Wrap up.", role: "Scribe", dependsOn: [1] },
    ]);
    const projectId = await project(admin, { title: "Detach", workflowId: wf, videoModelRowId: ids.models.vid_openai, memory: true });
    made.runProject = projectId;

    // Start, read the first event, and hang up.
    const hangUp = new AbortController();
    const first = await admin.raw(`/api/projects/${projectId}/run`, { method: "POST", signal: hangUp.signal });
    await first.body.getReader().read();
    hangUp.abort();
    eq("the run starts", first.status, 200);
    const second = await admin.post(`/api/projects/${projectId}/run`);
    eq("a second start while it runs is refused", [second.status, second.code], [409, "run_active"]);
    await sleep(1500);
    const midway = await admin.get(`/api/projects/${projectId}`);
    check("with nobody connected, it keeps running", ["queued", "planning", "running"].includes(midway.data?.project?.status), midway.data?.project?.status);
    const follow = await sse(admin, `/api/projects/${projectId}/events`);
    eq("a page that connects later gets the state so far, then the rest", [follow.events.at(-1), finished(follow.events).filter((e) => e.status === "succeeded").map((e) => e.seq).sort()], [{ type: "done", status: "succeeded" }, [1, 2, 3]]);
    check("  the plan comes with the tasks' ids", follow.events.find((e) => e.type === "plan")?.tasks?.every((t) => typeof t.id === "string"), follow.events.find((e) => e.type === "plan"));
    const idle = await sse(admin, `/api/projects/${projectId}/events`);
    check("when nothing runs, the stream is the result and ends at once", idle.events.at(-1)?.type === "done" && idle.events.some((e) => e.type === "final"), idle.events.map((e) => e.type));
    eq("another user cannot follow it", (await bob.raw(`/api/projects/${projectId}/events`)).status, 403);

    begin("Runs: an instruction for one run, and memory of earlier runs");
    const again = await runProject(admin, projectId, { input: "Second time." });
    const script = taskOf(again.events, 1);
    check("the second run is told what the first delivered, and gets its instruction", /\[with:earlier-runs,run-input\]/.test(script?.artifact ?? ""), script?.artifact);
    const history = await admin.get(`/api/projects/${projectId}/runs`);
    eq("both runs are in the history, newest first", history.data?.runs?.map((r) => [r.status, r.trigger, r.input, r.hasDeliverable]), [["succeeded", "manual", "Second time.", true], ["succeeded", "manual", null, true]]);
    const one = await admin.get(`/api/projects/${projectId}/runs/${history.data?.runs?.[1]?.id}`);
    check("an earlier run keeps what it delivered", /FINAL DELIVERABLE/.test(one.data?.run?.deliverable ?? ""), one.data?.run);
    eq("another user cannot read the history", (await bob.get(`/api/projects/${projectId}/runs`)).status, 403);
    eq("an instruction over the limit is refused", (await admin.post(`/api/projects/${projectId}/run`, { input: "x".repeat(4001) })).status, 400);
    const off = await admin.patch(`/api/projects/${projectId}`, { memory: false });
    eq("the memory can be switched off", off.data?.project?.memory, false);
    const forgetful = await runProject(admin, projectId);
    check("  then a run is not told about earlier ones", /OUTPUT of "Script" \[deps:none\]$/.test(taskOf(forgetful.events, 1)?.artifact ?? ""), taskOf(forgetful.events, 1)?.artifact);
    await admin.patch(`/api/projects/${projectId}`, { memory: true });

    begin("Runs: videos finish without a page asking");
    await mockReset();
    const video = await admin.post("/api/media/videos", { modelRowId: ids.models.vid_openai, prompt: "nobody is watching", durationSeconds: 4 });
    const done = await until(async () => (await admin.get(`/api/media/${video.data?.asset?.id}`)).data?.asset, (a) => a?.status !== "pending", { tries: 45, gapMs: 1000 });
    eq("the background worker asks the provider and stores the file", [done?.status, done?.sizeBytes], ["ready", 300000]);
    const bell = await admin.get("/api/notifications");
    check("  and its owner is told", bell.data?.notifications?.some((n) => n.title === "Your video is ready" && n.link === "/dashboard/studio"), bell.data?.notifications?.map((n) => n.title));

    begin("Runs: stopping one");
    const slowWf = await workflow("Never ends", [{ title: "Clip", objective: "A clip.", role: "Clipper", kind: "video" }]);
    const slow = await project(admin, { title: "Cancel me", workflowId: slowWf, videoModelRowId: ids.models["vid-slow"] });
    const cut = new AbortController();
    const started = await admin.raw(`/api/projects/${slow}/run`, { method: "POST", signal: cut.signal });
    await started.body.getReader().read();
    cut.abort();
    await until(async () => (await admin.get(`/api/projects/${slow}`)).data?.project, (p) => p?.tasks?.[0]?.status === "running", { tries: 20, gapMs: 500 });
    const cancel = await admin.post(`/api/projects/${slow}/cancel`);
    eq("the stop is accepted", [cancel.status, cancel.data?.running], [200, true]);
    const stopped = await until(async () => (await admin.get(`/api/projects/${slow}`)).data?.project, (p) => p?.status === "cancelled", { tries: 30, gapMs: 500 });
    check("the run ends as cancelled, and its video task says why", stopped?.status === "cancelled" && /Cancelled while the video/.test(stopped.tasks?.[0]?.error ?? ""), [stopped?.status, stopped?.tasks?.[0]?.error]);
    eq("stopping when nothing runs does nothing", (await admin.post(`/api/projects/${slow}/cancel`)).data?.running, false);
    const pendingVideo = (await admin.get(`/api/media?projectId=${slow}`)).data?.assets?.[0];
    if (pendingVideo) await admin.del(`/api/media/${pendingVideo.id}`);

    begin("Schedules");
    const tooOften = await admin.post(`/api/projects/${projectId}/schedules`, { cron: "* * * * *", timezone: "Asia/Jakarta" });
    check("more often than every 5 minutes is refused", tooOften.status === 400 && /at most every 5 minutes/.test(tooOften.error ?? ""), tooOften.error);
    const badZone = await admin.post(`/api/projects/${projectId}/schedules`, { cron: "0 8 * * 1-5", timezone: "Mars/Olympus" });
    check("an unknown time zone is refused", badZone.status === 400 && /not a time zone/.test(badZone.error ?? ""), badZone.error);
    eq("an expression that is not cron is refused", (await admin.post(`/api/projects/${projectId}/schedules`, { cron: "every morning", timezone: "UTC" })).status, 400);
    eq("a day that never comes is refused", (await admin.post(`/api/projects/${projectId}/schedules`, { cron: "0 8 31 2 *", timezone: "UTC" })).status, 400);
    const created = await admin.post(`/api/projects/${projectId}/schedules`, { cron: "0  8 * * 1-5", timezone: "Asia/Jakarta", input: "Scheduled." });
    const s = created.data?.schedule;
    eq("a schedule is created and described in words", [created.status, s?.cron, s?.description, s?.timezone, s?.enabled], [201, "0 8 * * 1-5", "Every weekday at 08:00", "Asia/Jakarta", true]);
    // 08:00 in Jakarta is 01:00 UTC.
    eq("its next time is counted in its time zone", new Date(s?.nextRunAt ?? 0).toISOString().slice(11, 16), "01:00");
    eq("another user cannot add one", (await bob.post(`/api/projects/${projectId}/schedules`, { cron: "0 8 * * *", timezone: "UTC" })).status, 403);

    const db = database();
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 1000, s.id);
    const fired = await until(async () => (await admin.get(`/api/projects/${projectId}/schedules`)).data?.schedules?.[0], (x) => Boolean(x?.lastStatus), { tries: 20, gapMs: 1000 });
    eq("when its time comes, the worker starts the run", [fired?.lastStatus, fired?.lastError], ["started", null]);
    check("  and sets the next time", fired?.nextRunAt > Date.now(), fired?.nextRunAt);
    await sse(admin, `/api/projects/${projectId}/events`);
    const afterSchedule = await admin.get(`/api/projects/${projectId}/runs`);
    eq("  the run is in the history as started by the schedule, with its instruction", [afterSchedule.data?.runs?.[0]?.trigger, afterSchedule.data?.runs?.[0]?.input, afterSchedule.data?.runs?.[0]?.status], ["schedule", "Scheduled.", "succeeded"]);
    const told = await admin.get("/api/notifications");
    check("  its owner is told how it went", told.data?.notifications?.some((n) => n.title === "Run finished: Detach"), told.data?.notifications?.map((n) => n.title));

    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 20 * 60_000, s.id);
    const late = await until(async () => (await admin.get(`/api/projects/${projectId}/schedules`)).data?.schedules?.[0], (x) => x?.lastStatus === "skipped", { tries: 20, gapMs: 1000 });
    check("a time that passed long ago (the server was down) is skipped, not run late", late?.lastStatus === "skipped" && /not running at the scheduled time/.test(late.lastError ?? ""), [late?.lastStatus, late?.lastError]);
    const offNow = await admin.patch(`/api/projects/${projectId}/schedules/${s.id}`, { enabled: false });
    eq("a schedule can be switched off", [offNow.data?.schedule?.enabled, offNow.data?.schedule?.nextRunAt], [false, null]);
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 1000, s.id);
    await sleep(7000);
    eq("  then it starts nothing", (await admin.get(`/api/projects/${projectId}/runs`)).data?.runs?.length, afterSchedule.data?.runs?.length);
    eq("another user cannot change it", (await bob.patch(`/api/projects/${projectId}/schedules/${s.id}`, { enabled: true })).status, 403);
    eq("it can be deleted", [(await admin.del(`/api/projects/${projectId}/schedules/${s.id}`)).status, (await admin.get(`/api/projects/${projectId}/schedules`)).data?.schedules?.length], [200, 0]);

    begin("Schedules: a project that asks for approval");
    const gated = await project(admin, { title: "Needs a yes", workflowId: await workflow("One step", [{ title: "Only", objective: "One.", role: "Scribe" }]), requiresApproval: true });
    const gs = await admin.post(`/api/projects/${gated}/schedules`, { cron: "0 9 * * *", timezone: "UTC" });
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 1000, gs.data?.schedule?.id);
    const waiting = await until(async () => (await admin.get(`/api/projects/${gated}/schedules`)).data?.schedules?.[0], (x) => Boolean(x?.lastStatus), { tries: 20, gapMs: 1000 });
    check("the run does not start; the schedule says what it waits for", waiting?.lastStatus === "skipped" && /approval/.test(waiting.lastError ?? ""), [waiting?.lastStatus, waiting?.lastError]);
    eq("  the project waits for the approval", (await admin.get(`/api/projects/${gated}`)).data?.project?.status, "needs_approval");
    check("  and its owner is told", (await admin.get("/api/notifications")).data?.notifications?.some((n) => n.title === "Run is waiting for approval: Needs a yes"), null);
    await admin.del(`/api/projects/${gated}/schedules/${gs.data?.schedule?.id}`);

    begin("Runs: picked up again after the server stopped");
    // Leave the last run the way a server that was killed would: marked as
    // running by a process that is gone, with its last task unfinished.
    const lastRun = db.prepare("SELECT id FROM project_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId);
    await mockReset();
    db.transaction(() => {
      db.prepare("UPDATE project_runs SET status = 'running', worker_id = 'a-process-that-is-gone', heartbeat_at = ?, finished_at = NULL WHERE id = ?").run(Date.now() - 5 * 60_000, lastRun.id);
      db.prepare("UPDATE projects SET status = 'running', final_deliverable = NULL WHERE id = ?").run(projectId);
      db.prepare("UPDATE project_tasks SET status = 'running', artifact = NULL WHERE project_id = ? AND seq = 3").run(projectId);
    })();
    const resumed = await until(async () => (await admin.get(`/api/projects/${projectId}`)).data?.project, (p) => p?.status !== "running", { tries: 40, gapMs: 1000 });
    eq("the worker takes the run over and finishes it", [resumed?.status, resumed?.tasks?.map((t) => t.status)], ["succeeded", ["succeeded", "succeeded", "succeeded"]]);
    const log = await mockLog();
    const asked = log.filter((l) => l.path.endsWith("/chat/completions")).map((l) => (String(l.body?.messages?.at(-1)?.content ?? "").match(/^Task: (.*)$/m) ?? [])[1] ?? "manager");
    eq("only the unfinished task is done again, then the summary and the review", asked, ["Wrap", "manager", "manager"]);
    eq("no video is generated a second time", log.filter((l) => l.method === "POST" && /\/videos$/.test(l.path)).length, 0);
    eq("the run records that it was picked up", db.prepare("SELECT resumes FROM project_runs WHERE id = ?").get(lastRun.id)?.resumes, 1);

    begin("Runs: a project that an older version left running");
    // Before 1.5 a project ran inside the request that started it. A server
    // that stopped meanwhile left it "running", with no run to pick up.
    const legacy = await project(admin, { title: "Left running", workflowId: wf, videoModelRowId: ids.models.vid_openai });
    const outcome = (run) => run.events.find((e) => e.type === "done")?.status;
    eq("it runs once", outcome(await runProject(admin, legacy)), "succeeded");
    db.transaction(() => {
      db.prepare("DELETE FROM project_runs WHERE project_id = ?").run(legacy);
      db.prepare("UPDATE projects SET status = 'running', final_deliverable = NULL, updated_at = ? WHERE id = ?").run(Date.now() - 10 * 60_000, legacy);
      db.prepare("UPDATE project_tasks SET status = 'running', artifact = NULL WHERE project_id = ? AND seq = 3").run(legacy);
    })();
    const released = await until(async () => (await admin.get(`/api/projects/${legacy}`)).data?.project, (p) => p?.status !== "running", { tries: 50, gapMs: 1000 });
    eq("it is ended instead of looking busy for ever", [released?.status, released?.tasks?.map((t) => t.status)], ["failed", ["succeeded", "succeeded", "failed"]]);
    check("  and says why", /server stopped/.test(released?.error ?? "") && /server stopped/.test(released?.tasks?.[2]?.error ?? ""), [released?.error, released?.tasks?.[2]?.error]);
    eq("  it can be run again", outcome(await runProject(admin, legacy)), "succeeded");
    db.close();
  }

  // ─── Notifications and the webhook ─────────────────────────────────────────

  async function notificationChecks() {
    begin("Notifications");
    // Something to be told about, if the other parts did not run.
    const wf = await workflow("Bell", [{ title: "Ring", objective: "Ring.", role: "Ringer" }]);
    await agent("Ringer", "Ringer");
    const projectId = await project(carol, { title: "Carol's bell", workflowId: wf });
    await fetch(`${MOCK}/hook/reset`);

    const saved = await carol.raw("/api/account/webhook", { method: "PUT", body: JSON.stringify({ url: `${MOCK}/hook/ok` }) });
    const savedBody = await saved.json();
    const secret = savedBody.secret;
    check("a webhook is saved; its signing secret is shown once", saved.status === 200 && /^whsec_/.test(secret ?? "") && savedBody.webhook?.url === `${MOCK}/hook/ok`, savedBody);
    const again = await (await carol.raw("/api/account/webhook", { method: "PUT", body: JSON.stringify({ url: `${MOCK}/hook/ok` }) })).json();
    eq("  saving again does not show it", again.secret, null);
    const shown = await carol.get("/api/account/webhook");
    check("  and it is never in what the server answers later", !JSON.stringify(shown.data).includes(secret), shown.data);
    const priv = await carol.raw("/api/account/webhook", { method: "PUT", body: JSON.stringify({ url: "http://10.0.0.5/hook" }) });
    check("an address on a private network is refused", priv.status === 400 && /private network/.test((await priv.json()).error?.message ?? ""), priv.status);

    const test = await carol.post("/api/account/webhook/test");
    eq("a test message can be sent", test.status, 200);
    let deliveries = await (await fetch(`${MOCK}/hook/log`)).json();
    const d = deliveries.at(-1);
    const [t, v1sig] = String(d?.signature ?? "").split(",");
    const expected = createHmac("sha256", secret).update(`${t?.slice(2)}.${d?.raw}`).digest("hex");
    eq("it arrives signed with the secret", [d?.event, v1sig?.slice(3)], ["system.info", expected]);
    check("  with the message as text too, for chat tools", d?.body?.text?.includes("Test notification") && d.body.content === d.body.text, d?.body);

    const run = await runProject(carol, projectId);
    eq("a run finishes", run.events.at(-1)?.status, "succeeded");
    const list = await carol.get("/api/notifications");
    const note = list.data?.notifications?.find((n) => n.title === "Run finished: Carol's bell");
    eq("the bell has it, unread, with a link to the project", [note?.level, note?.read, note?.link, list.data?.unread >= 1], ["success", false, `/dashboard/projects/${projectId}`, true]);
    deliveries = await until(async () => (await fetch(`${MOCK}/hook/log`)).json(), (l) => l.some((x) => x.body?.title === "Run finished: Carol's bell"), { tries: 20, gapMs: 1000 });
    const delivered = deliveries.find((x) => x.body?.title === "Run finished: Carol's bell");
    check("the worker delivers it to the webhook, with a full link", delivered?.event === "run.success" && delivered.body.url === `${APP}/dashboard/projects/${projectId}`, delivered?.body);
    check("  one user's notifications are not another's", !(await bob.get("/api/notifications")).data?.notifications?.some((n) => n.title.includes("Carol")), null);

    const read = await carol.post("/api/notifications/read", { id: note?.id });
    eq("one can be marked as read", [read.status, (await carol.get("/api/notifications")).data?.notifications?.find((n) => n.id === note?.id)?.read], [200, true]);
    eq("all can be marked as read", (await carol.post("/api/notifications/read", {})).data?.unread, 0);
    eq("the list can be cleared", [(await carol.del("/api/notifications")).status, (await carol.get("/api/notifications")).data?.notifications?.length], [200, 0]);

    const rotated = await (await carol.raw("/api/account/webhook?rotate=1", { method: "PUT", body: JSON.stringify({ url: `${MOCK}/hook/fail` }) })).json();
    check("a new secret can be made", /^whsec_/.test(rotated.secret ?? "") && rotated.secret !== secret, rotated.secret);
    const failing = await carol.post("/api/account/webhook/test");
    check("a receiver that fails: the test says so", failing.status === 502 && /answered 500/.test(failing.error ?? ""), `${failing.status} ${failing.error}`);
    eq("  and the webhook remembers it", (await carol.get("/api/account/webhook")).data?.webhook?.lastStatus, "error");
    eq("it can be removed", [(await carol.del("/api/account/webhook")).status, (await carol.get("/api/account/webhook")).data?.webhook], [200, null]);
    eq("signed out: refused", (await ctx.anon.get("/api/notifications")).status, 401);
  }

  // ─── The public API ────────────────────────────────────────────────────────

  async function publicApi() {
    begin("API keys");
    const created = await admin.post("/api/account/api-keys", { name: "CI", scopes: ["chat", "embeddings", "media", "projects"], rateLimitPerMinute: 600 });
    const key = created.data?.secret;
    check("a key is created and shown once", created.status === 201 && /^xn_[A-Za-z0-9_-]{40,}$/.test(key ?? "") && created.data.key.prefix === key.slice(0, 10), created.data?.key);
    const listed = await admin.get("/api/account/api-keys");
    check("  later only its first characters are shown", listed.data?.keys?.[0]?.prefix === key.slice(0, 10) && !JSON.stringify(listed.data).includes(key), listed.data?.keys?.[0]);
    eq("a key without a scope is refused", (await admin.post("/api/account/api-keys", { name: "Nothing", scopes: [] })).status, 400);

    eq("no key: 401, in the shape API clients read", [(await v1json("/models")).status, (await v1json("/models")).error?.type], [401, "authentication_error"]);
    eq("a wrong key: 401", (await v1json("/models", { key: "xn_wrongwrongwrongwrongwrongwrongwrongwrongwr" })).error?.code, "invalid_api_key");
    const cookieOnly = await admin.raw("/api/v1/models");
    eq("a signed-in browser session is not a key", cookieOnly.status, 401);

    begin("Public API: chat, in the OpenAI format");
    const models = await v1json("/models", { key });
    const names = models.data?.data?.map((m) => m.id) ?? [];
    check("the models are listed under the names the API takes", names.includes("chat-mini") && names.includes("tts-1") && models.data.object === "list", names);
    check("  a name that two providers have is listed with its provider", names.includes("Mock OpenAI-style/img-ok") && !names.includes("img-ok"), names.filter((n) => n.includes("img-ok")));
    const chat = await v1json("/chat/completions", { key, method: "POST", body: { model: "chat-mini", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }] } });
    eq("a completion", [chat.status, chat.data?.object, chat.data?.choices?.[0]?.message, chat.data?.choices?.[0]?.finish_reason, chat.data?.usage], [200, "chat.completion", { role: "assistant", content: "ok" }, "stop", { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }]);
    const streamed = await v1("/chat/completions", { key, method: "POST", body: { model: "chat-mini", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Reply with the single word: ok" }] } });
    const streamText = await streamed.text();
    const chunks = streamText.split("\n\n").filter(Boolean).map((b) => b.replace(/^data: /, ""));
    const parsed = chunks.filter((c) => c !== "[DONE]").map((c) => JSON.parse(c));
    eq("a streamed completion: pieces, the reason it stopped, the usage, then [DONE]", [streamed.headers.get("content-type")?.split(";")[0], parsed.map((c) => c.choices[0]?.delta?.content ?? "").join(""), parsed.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, parsed.at(-1)?.usage?.total_tokens, chunks.at(-1)], ["text/event-stream", "ok", "stop", 30, "[DONE]"]);
    const tool = { type: "function", function: { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } } };
    const called = await v1json("/chat/completions", { key, method: "POST", body: { model: "chat-mini", messages: [{ role: "user", content: "Task: Tool: files\n\ngo" }], tools: [tool] } });
    const call = called.data?.choices?.[0]?.message?.tool_calls?.[0];
    eq("the model's tool calls are passed on", [called.data?.choices?.[0]?.finish_reason, call?.type, call?.function?.name, JSON.parse(call?.function?.arguments ?? "{}").path], ["tool_calls", "function", "write_file", "notes/plan.md"]);
    const answered = await v1json("/chat/completions", { key, method: "POST", body: { model: "chat-mini", tools: [tool], messages: [{ role: "user", content: "Task: Tool: files\n\ngo" }, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call?.id, content: "Saved." }] } });
    eq("  and the client's tool results go back to the model", [answered.status, answered.data?.choices?.[0]?.message?.content], [200, "DONE after 1 tool results. LAST: Saved."]);
    const streamedCall = await v1("/chat/completions", { key, method: "POST", body: { model: "chat-mini", stream: true, messages: [{ role: "user", content: "Task: Tool: files\n\ngo" }], tools: [tool] } });
    const callChunks = (await streamedCall.text()).split("\n\n").filter((b) => b && !b.includes("[DONE]")).map((b) => JSON.parse(b.replace(/^data: /, "")));
    eq("  streamed, a tool call arrives whole", callChunks.find((c) => c.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0].function.name, "write_file");

    const wrongKind = await v1json("/chat/completions", { key, method: "POST", body: { model: "tts-1", messages: [{ role: "user", content: "hi" }] } });
    check("a speech model cannot chat", wrongKind.status === 400 && /not a chat model/.test(wrongKind.error?.message ?? ""), wrongKind.error);
    eq("an unknown model: 404", [(await v1json("/chat/completions", { key, method: "POST", body: { model: "nope", messages: [{ role: "user", content: "hi" }] } })).error?.code], ["model_not_found"]);
    const ambiguous = await v1json("/images/generations", { key, method: "POST", body: { model: "img-ok", prompt: "x" } });
    check("a name that several providers have has to be said with its provider", ambiguous.status === 400 && ambiguous.error?.code === "model_ambiguous", ambiguous.error);
    const bad = await v1json("/chat/completions", { key, method: "POST", body: { model: "chat-mini", messages: [] } });
    eq("a bad request names the field", [bad.status, bad.error?.type, bad.error?.param], [400, "invalid_request_error", "messages"]);
    eq("a body that is not JSON", (await v1json("/chat/completions", { key, method: "POST", body: "{not json" })).status, 400);
    eq("an image in a message is refused for now, clearly", (await v1json("/chat/completions", { key, method: "POST", body: { model: "chat-mini", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] } })).status, 400);

    begin("Public API: embeddings, images, speech, videos");
    const emb = await v1json("/embeddings", { key, method: "POST", body: { model: "text-embedding-3-small", input: ["refund policy", "lighthouse"] } });
    eq("embeddings", [emb.status, emb.data?.data?.length, emb.data?.data?.[1]?.index, emb.data?.data?.[0]?.embedding?.length, emb.data?.usage], [200, 2, 1, 24, { prompt_tokens: 14, total_tokens: 14 }]);
    const b64 = await v1json("/embeddings", { key, method: "POST", body: { model: "text-embedding-3-small", input: "x", encoding_format: "base64" } });
    eq("  as base64 of 32-bit floats when asked", Buffer.from(b64.data?.data?.[0]?.embedding ?? "", "base64").length, 24 * 4);
    const img = await v1json("/images/generations", { key, method: "POST", body: { model: "Mock OpenAI-style/img-ok", prompt: "a lighthouse", n: 2 } });
    check("images: the answer links the files", img.status === 200 && img.data?.data?.length === 2 && img.data.data.every((x) => x.url?.startsWith(`${APP}/api/v1/media/`)), img.data);
    const content = await v1(img.data.data[0].url.replace(`${APP}/api/v1`, ""), { key });
    eq("  which the key can fetch", [content.status, content.headers.get("content-type")], [200, "image/png"]);
    await content.arrayBuffer();
    eq("  and nobody without it", (await fetch(img.data.data[0].url)).status, 401);
    const inline = await v1json("/images/generations", { key, method: "POST", body: { model: "Mock OpenAI-style/img-ok", prompt: "a lamp", response_format: "b64_json" } });
    check("  or carries them, when asked", Buffer.from(inline.data?.data?.[0]?.b64_json ?? "", "base64").subarray(1, 4).toString() === "PNG", inline.status);
    const spoken = await v1("/audio/speech", { key, method: "POST", body: { model: "tts-1", input: "Hello there, this is the API speaking.", voice: "alloy" } });
    const spokenBytes = Buffer.from(await spoken.arrayBuffer());
    eq("speech: the answer is the audio itself", [spoken.status, spoken.headers.get("content-type"), spokenBytes.subarray(0, 4).toString(), Boolean(spoken.headers.get("x-nexus-asset-id"))], [200, "audio/wav", "RIFF", true]);

    const video = await v1json("/videos", { key, method: "POST", body: { model: "Mock OpenAI-style/vid-ok", prompt: "waves", seconds: "4" } });
    eq("videos: started, in progress", [video.status, video.data?.object, video.data?.status, video.data?.content_url], [201, "video", "in_progress", null]);
    // Asked every second, as a client would. Each request has to reach the
    // provider anew: an answer kept from the first one would never change.
    const finishedVideo = await until(async () => (await v1json(`/videos/${video.data?.id}`, { key })).data, (v) => v?.status !== "in_progress", { tries: 25, gapMs: 1000 });
    eq("  asking again and again sees it finish", [finishedVideo?.status, finishedVideo?.content_url, finishedVideo?.seconds], ["completed", `${APP}/api/v1/videos/${video.data?.id}/content`, 4]);
    const range = await v1(`/videos/${video.data?.id}/content`, { key, headers: { range: "bytes=0-99" } });
    eq("  the file, with byte ranges", [range.status, range.headers.get("content-range"), (await range.arrayBuffer()).byteLength], [206, "bytes 0-99/300000", 100]);

    begin("Public API: projects and runs");
    await agent("Apiworker", "Apiworker");
    const wf = await workflow("API", [{ title: "Only", objective: "One step.", role: "Apiworker" }]);
    const projectId = await project(admin, { title: "From the API", workflowId: wf });
    const projects = await v1json("/projects", { key });
    check("the projects are listed", projects.data?.data?.some((p) => p.id === projectId && p.title === "From the API"), projects.data?.data?.map((p) => p.title));
    const started = await v1json(`/projects/${projectId}/runs`, { key, method: "POST", body: { input: "From a program." } });
    eq("a run is started: accepted, queued", [started.status, started.data?.object, started.data?.status, started.data?.trigger, started.data?.input], [202, "run", "queued", "api", "From a program."]);
    eq("  a second start while it runs: 409", (await v1json(`/projects/${projectId}/runs`, { key, method: "POST" })).status, 409);
    const finishedRun = await until(async () => (await v1json(`/runs/${started.data?.id}`, { key })).data, (r) => !["queued", "running"].includes(r?.status), { tries: 40, gapMs: 1000 });
    eq("  it can be watched to its end", [finishedRun?.status, finishedRun?.tasks?.map((t) => [t.seq, t.status]), /FINAL DELIVERABLE/.test(finishedRun?.deliverable ?? "")], ["succeeded", [[1, "succeeded"]], true]);
    check("  the task got the run's instruction", /\[with:run-input\]/.test(finishedRun?.tasks?.[0]?.output ?? ""), finishedRun?.tasks?.[0]?.output);
    eq("  without a body, a run starts too", (await v1json(`/projects/${projectId}/runs`, { key, method: "POST" })).status, 202);
    await until(async () => (await v1json(`/projects/${projectId}/runs`, { key })).data?.data?.[0], (r) => !["queued", "running"].includes(r?.status), { tries: 40 });
    eq("  the runs are listed, newest first", (await v1json(`/projects/${projectId}/runs`, { key })).data?.data?.map((r) => r.trigger), ["api", "api"]);

    begin("Public API: what a key is allowed");
    const bobKey = (await bob.post("/api/account/api-keys", { name: "Bob", scopes: ["chat", "media", "projects"] })).data?.secret;
    eq("another user's key cannot read this user's media", (await v1(img.data.data[0].url.replace(`${APP}/api/v1`, ""), { key: bobKey })).status, 403);
    eq("  nor their runs: as if they did not exist", (await v1json(`/runs/${started.data?.id}`, { key: bobKey })).status, 404);
    eq("  nor start their projects", (await v1json(`/projects/${projectId}/runs`, { key: bobKey, method: "POST" })).status, 403);
    eq("  nor use a scope it was not given", [(await v1json("/embeddings", { key: bobKey, method: "POST", body: { model: "text-embedding-3-small", input: "x" } })).error?.code], ["insufficient_scope"]);

    const narrow = await admin.post("/api/account/api-keys", { name: "Narrow", scopes: ["chat"], monthlyTokenLimit: 40, modelRowIds: [ids.models.chat] });
    const narrowKey = narrow.data?.secret;
    eq("a key for some models lists only those", (await v1json("/models", { key: narrowKey })).data?.data?.map((m) => m.id), ["chat-mini"]);
    const ask = () => v1json("/chat/completions", { key: narrowKey, method: "POST", body: { model: "chat-mini", messages: [{ role: "user", content: "hi" }] } });
    const spent = [(await ask()).status, (await ask()).status];
    const over = await ask();
    eq("a monthly token limit stops the key when it is used up", [spent, over.status, over.error?.code], [[200, 200], 429, "quota_exceeded"]);
    const usage = (await admin.get("/api/account/api-keys")).data?.keys?.find((k) => k.id === narrow.data?.key?.id);
    eq("  what it used is counted under the key", [usage?.monthTokens, Boolean(usage?.lastUsedAt)], [60, true]);
    const ciUsage = (await admin.get("/api/account/api-keys")).data?.keys?.find((k) => k.id === created.data?.key?.id);
    check("  a finished video's cost is counted under the key that started it", ciUsage?.monthCost >= 0.4, ciUsage?.monthCost);

    const fast = (await admin.post("/api/account/api-keys", { name: "Slow lane", scopes: ["chat"], rateLimitPerMinute: 2 })).data?.secret;
    const hits = [(await v1json("/models", { key: fast })).status, (await v1json("/models", { key: fast })).status, (await v1json("/models", { key: fast })).status];
    eq("a requests-per-minute limit", hits, [200, 200, 429]);

    const expiring = await admin.post("/api/account/api-keys", { name: "Short", scopes: ["chat"], expiresInDays: 1 });
    const db = database();
    db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, expiring.data?.key?.id);
    db.close();
    eq("an expired key stops working", (await v1json("/models", { key: expiring.data?.secret })).status, 401);
    eq("another user cannot revoke a key", (await bob.del(`/api/account/api-keys/${narrow.data?.key?.id}`)).status, 404);
    eq("its owner can; it stops working at once", [(await admin.del(`/api/account/api-keys/${narrow.data?.key?.id}`)).status, (await v1json("/models", { key: narrowKey })).status], [200, 401]);
  }

  // ─── Other adapters ────────────────────────────────────────────────────────

  async function anthropicAdapter() {
    begin("Anthropic adapter");
    await mockReset();
    const base = `${MOCK}/anthropic/v1`;
    const created = await admin.post("/api/providers", { name: "Mock Anthropic", adapter: "anthropic", baseUrl: base, apiKey: ANTHROPIC_KEY });
    check("an Anthropic provider is created", created.status === 201, created.error);
    const ap = created.data?.provider?.id;
    const test = await admin.post(`/api/providers/${ap}/test`);
    check("the connection test works", test.status === 200 && test.data?.ok === true, test.data);
    const all = ["claude-mock-opus", "claude-mock-haiku", "claude-mock-refuse", "claude-mock-overloaded"];
    const discovered = await admin.post(`/api/providers/${ap}/models/discover`);
    eq("its models are listed, across pages", discovered.data?.models, all);
    const imported = await admin.post(`/api/providers/${ap}/models/discover`, { import: all });
    const byId = new Map(((await admin.get(`/api/models?providerId=${ap}`)).data?.models ?? []).map((m) => [m.modelId, m]));
    check("imported, they are chat models", imported.status === 200 && all.every((id) => byId.get(id)?.capabilities?.some((c) => c.capability === "text")), [...byId.values()].map((m) => [m.modelId, m.capabilities.map((c) => c.capability)]));
    const achat = byId.get("claude-mock-opus")?.id;

    const whole = await admin.post(`/api/models/${achat}/test`);
    check("a reply taken whole (Test Model)", whole.status === 200 && whole.data?.ok === true, whole.data);
    const chat = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: achat, systemPrompt: "Be brief.", messages: [{ role: "user", content: "Reply with the single word: ok" }] } });
    eq("chat, streamed; input read from the cache counts as input", [chat.events.filter((e) => e.delta).map((e) => e.delta).join(""), chat.events.find((e) => e.done)?.usage], ["ok", { promptTokens: 25, completionTokens: 9 }]);

    await agent("Claude", "Claudeworker", { primaryModelRowId: achat, tools: ["list_files", "read_file", "write_file", "edit_file"] });
    const wf = await workflow("Anthropic tools", [{ title: "Tool: files", objective: "Write the plan file.", role: "Claudeworker" }]);
    const projectId = await project(admin, { title: "Anthropic tools", workflowId: wf, managerModelRowId: achat });
    const run = await runProject(admin, projectId);
    const task = taskOf(run.events, 1);
    eq("an agent on Anthropic works with tools", [run.events.at(-1)?.status, task?.status, task?.steps, task?.toolCalls], ["succeeded", "succeeded", 5, 5]);
    eq("  its calls, in order", run.events.filter((e) => e.type === "tool").map((e) => `${e.call.name}${e.call.isError ? "!" : ""}`), ["write_file", "read_file", "edit_file", "list_files", "read_file!"]);
    check("  what it says before a tool call is not its deliverable", /^DONE after 5 tool results/.test(task?.artifact ?? "") && !/I will use a tool/.test(task?.artifact ?? ""), task?.artifact);

    const log = (await mockLog()).filter((l) => l.path.startsWith("/anthropic/"));
    const sent = log.filter((l) => l.path.endsWith("/messages")).map((l) => l.body ?? {});
    check("the key goes as a bearer token, with the API version", log.length > 0 && log.every((l) => l.authorization === `Bearer ${ANTHROPIC_KEY}` && !l.xApiKey && l.anthropicVersion === "2026-10-21"), log.map((l) => [l.path, l.anthropicVersion]));
    check("every request has max_tokens and no temperature", sent.length > 0 && sent.every((b) => Number.isInteger(b.max_tokens) && b.temperature === undefined), sent.map((b) => [b.max_tokens, b.temperature]));
    check("the system prompt goes in its own field, not as a message", sent.some((b) => typeof b.system === "string" && b.system.includes("Be brief.")) && sent.every((b) => (b.messages ?? []).every((m) => m.role !== "system")), sent.map((b) => typeof b.system));
    const withResults = sent.find((b) => (b.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result")))?.messages ?? [];
    const callTurn = withResults.find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "tool_use"));
    const resultTurn = withResults[withResults.indexOf(callTurn) + 1];
    eq("a tool call goes back with the model's thinking unchanged", callTurn?.content?.[0], { type: "thinking", thinking: "The task says which tool comes next.", signature: "sig-anthropic-mock" });
    check("  and its result in the next turn, under the same id", resultTurn?.role === "user" && resultTurn?.content?.[0]?.type === "tool_result" && resultTurn.content[0].tool_use_id === callTurn?.content?.find((c) => c.type === "tool_use")?.id, [callTurn?.content, resultTurn?.content]);
    const twoResults = sent.flatMap((b) => b.messages ?? []).find((m) => Array.isArray(m.content) && m.content.filter((c) => c.type === "tool_result").length === 2);
    check("  two calls of one step are answered in one turn; a failed one is marked", twoResults?.content?.[1]?.is_error === true && twoResults?.content?.[0]?.is_error === undefined, twoResults?.content);

    const apiKey = (await admin.post("/api/account/api-keys", { name: "Anthropic checks", scopes: ["chat"] })).data?.secret;
    const tool = { type: "function", function: { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } } };
    const ask = [{ role: "user", content: "Task: Tool: files\n\ngo" }];
    const called = await v1json("/chat/completions", { key: apiKey, method: "POST", body: { model: "claude-mock-opus", messages: ask, tools: [tool] } });
    const call = called.data?.choices?.[0]?.message?.tool_calls?.[0];
    eq("through the API: a tool call arrives in OpenAI's format", [called.status, called.data?.choices?.[0]?.finish_reason, call?.type, call?.function?.name, JSON.parse(call?.function?.arguments ?? "{}").path], [200, "tool_calls", "function", "write_file", "notes/plan.md"]);
    const answered = await v1json("/chat/completions", { key: apiKey, method: "POST", body: { model: "claude-mock-opus", tools: [tool], messages: [...ask, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call?.id, content: "Saved." }] } });
    eq("  and the client's tool result goes back to the model", [answered.status, answered.data?.choices?.[0]?.message?.content, answered.data?.choices?.[0]?.finish_reason], [200, "DONE after 1 tool results. LAST: Saved.", "stop"]);
    const streamedCall = await v1("/chat/completions", { key: apiKey, method: "POST", body: { model: "claude-mock-opus", stream: true, stream_options: { include_usage: true }, messages: ask, tools: [tool] } });
    const callChunks = (await streamedCall.text()).split("\n\n").filter((b) => b && !b.includes("[DONE]")).map((b) => JSON.parse(b.replace(/^data: /, "")));
    const streamedTool = callChunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    eq("  streamed: the call put together from its pieces, the reason, the usage", [streamedTool[0]?.function?.name, JSON.parse(streamedTool.map((t) => t.function?.arguments ?? "").join("") || "{}").path, callChunks.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason, callChunks.at(-1)?.usage?.prompt_tokens], ["write_file", "notes/plan.md", "tool_calls", 25]);

    const refusedChat = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: byId.get("claude-mock-refuse")?.id, messages: [{ role: "user", content: "hi" }] } });
    check("a refusal is shown with its reason, not as an empty reply", /declined this request: \[cyber\] This request is outside/.test(refusedChat.events.find((e) => e.error)?.error ?? ""), refusedChat.events);
    const refusedWhole = await admin.post(`/api/models/${byId.get("claude-mock-refuse")?.id}/test`);
    check("  also when the reply is taken whole", refusedWhole.data?.ok === false && /declined this request/.test(refusedWhole.data?.error ?? ""), refusedWhole.data);
    const broken = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: byId.get("claude-mock-overloaded")?.id, messages: [{ role: "user", content: "hi" }] } });
    check("a reply that breaks off: what arrived, then the provider's error", broken.events.some((e) => e.delta) && /overloaded_error: Overloaded/.test(broken.events.find((e) => e.error)?.error ?? ""), broken.events);
    const busy = await admin.post(`/api/models/${byId.get("claude-mock-overloaded")?.id}/test`);
    check("an error answer: the provider's message", busy.data?.ok === false && /Overloaded/.test(busy.data?.error ?? ""), busy.data);

    await mockReset();
    const byHeader = await admin.post("/api/providers", { name: "Anthropic, x-api-key", adapter: "anthropic", baseUrl: base, apiKey: ANTHROPIC_KEY, authType: "header", authHeaderName: "x-api-key", apiVersion: "2023-06-01" });
    const headerTest = await admin.post(`/api/providers/${byHeader.data?.provider?.id}/test`);
    const headerLog = (await mockLog()).filter((l) => l.path.startsWith("/anthropic/"));
    check("the key can go in the x-api-key header instead, with another API version", headerTest.data?.ok === true && headerLog.length > 0 && headerLog.every((l) => l.xApiKey === ANTHROPIC_KEY && !l.authorization && l.anthropicVersion === "2023-06-01"), [headerTest.data, headerLog.map((l) => [l.xApiKey ? "x-api-key" : "", l.authorization ? "bearer" : "", l.anthropicVersion])]);
    const wrongKey = await admin.post("/api/providers", { name: "Anthropic, wrong key", adapter: "anthropic", baseUrl: base, apiKey: "sk-ant-WRONG-0123456789abcdefghijklmnopqrstuv" });
    const wrongTest = await admin.post(`/api/providers/${wrongKey.data?.provider?.id}/test`);
    check("a wrong key: the provider's message, without the key", wrongTest.data?.ok === false && /invalid x-api-key/.test(wrongTest.data?.error ?? "") && !/sk-ant-WRONG/.test(JSON.stringify(wrongTest.data)), wrongTest.data);
  }

  async function adapters() {
    await anthropicAdapter();

    begin("Gemini adapter");
    await mockReset();
    const created = await admin.post("/api/providers", { name: "Mock Gemini", adapter: "gemini", baseUrl: `${MOCK}/gemini/v1beta`, apiKey: GEMINI_KEY });
    check("a Gemini provider is created", created.status === 201, created.error);
    const gp = created.data?.provider?.id;
    const test = await admin.post(`/api/providers/${gp}/test`);
    check("the connection test works", test.status === 200 && test.data?.ok === true, test.data);
    const discovered = await admin.post(`/api/providers/${gp}/models/discover`);
    eq("its models are listed, across pages", discovered.data?.models, ["gemini-mock-flash", "gemini-embedding-mock", "gemini-mock-flash-preview-tts", "gemini-mock-flash-image"]);
    eq("  each with the type it is taken to be", Object.fromEntries(Object.entries(discovered.data?.suggested ?? {}).map(([id, s]) => [id, s.type])), {
      "gemini-mock-flash": "chat",
      "gemini-embedding-mock": "embedding",
      "gemini-mock-flash-preview-tts": "speech",
      "gemini-mock-flash-image": "image",
    });
    const imported = await admin.post(`/api/providers/${gp}/models/discover`, { import: ["gemini-mock-flash", "gemini-embedding-mock", "gemini-mock-flash-preview-tts", "gemini-mock-flash-image"] });
    const byId = new Map(((await admin.get(`/api/models?providerId=${gp}`)).data?.models ?? []).map((m) => [m.modelId, m]));
    check("imported, they get those capabilities, so an image model is no chat model", imported.status === 200 && byId.get("gemini-mock-flash-image")?.capabilities?.map((c) => c.capability).join() === "image_generation" && byId.get("gemini-embedding-mock")?.capabilities?.map((c) => c.capability).join() === "embeddings", [...byId.values()].map((m) => [m.modelId, m.capabilities.map((c) => c.capability)]));
    const gchat = byId.get("gemini-mock-flash")?.id;

    const chat = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: gchat, systemPrompt: "Be brief.", messages: [{ role: "user", content: "Reply with the single word: ok" }] } });
    eq("chat, streamed", [chat.events.filter((e) => e.delta).map((e) => e.delta).join(""), chat.events.find((e) => e.done)?.usage], ["ok", { promptTokens: 11, completionTokens: 7 }]);
    const speech = await admin.post("/api/media/speech", { modelRowId: byId.get("gemini-mock-flash-preview-tts")?.id, text: "Hello from Gemini.", voice: "Kore" });
    eq("speech: the bare samples it sends become a WAV file", [speech.status, speech.data?.asset?.mimeType, speech.data?.asset?.durationSeconds], [201, "audio/wav", 1]);
    const image = await admin.post("/api/media/images", { modelRowId: byId.get("gemini-mock-flash-image")?.id, prompt: "a lamp", aspectRatio: "9:16" });
    eq("an image", [image.status, image.data?.assets?.[0]?.mimeType], [201, "image/png"]);
    const col = await admin.post("/api/knowledge", { name: "Gemini notes", embeddingModelRowId: byId.get("gemini-embedding-mock")?.id });
    await admin.post(`/api/knowledge/${col.data?.collection?.id}/documents`, { title: "Hours", text: "The shop is open from nine to five on weekdays." });
    const embedded = await until(async () => (await admin.get(`/api/knowledge/${col.data?.collection?.id}`)).data?.documents?.[0], (d) => d?.embeddingStatus !== "pending", { tries: 30 });
    eq("embeddings, for a knowledge collection", embedded?.embeddingStatus, "ready");
    await admin.del(`/api/knowledge/${col.data?.collection?.id}`);

    await agent("Gem", "Gemworker", { primaryModelRowId: gchat, tools: ["list_files", "read_file", "write_file", "edit_file"] });
    const wf = await workflow("Gemini tools", [{ title: "Tool: files", objective: "Write the plan file.", role: "Gemworker" }]);
    const projectId = await project(admin, { title: "Gemini tools", workflowId: wf, managerModelRowId: gchat });
    const run = await runProject(admin, projectId);
    const task = taskOf(run.events, 1);
    eq("an agent on Gemini works with tools", [run.events.at(-1)?.status, task?.status, task?.steps, task?.toolCalls], ["succeeded", "succeeded", 5, 5]);

    const log = (await mockLog()).filter((l) => l.path.startsWith("/gemini/"));
    check("the key goes in the x-goog-api-key header, never as a bearer token or in the address", log.length > 0 && log.every((l) => l.xGoogApiKey === GEMINI_KEY && !l.authorization && !/key=/.test(l.path)), log.filter((l) => !l.xGoogApiKey || l.authorization).map((l) => l.path));
    const toolTurn = log.filter((l) => /generateContent$/.test(l.path)).map((l) => l.body?.contents ?? []).find((c) => c.some((m) => m.parts?.some((p) => p.functionResponse)));
    const modelTurn = toolTurn?.find((m) => m.role === "model" && m.parts?.some((p) => p.functionCall));
    const resultTurn = toolTurn?.find((m) => m.parts?.some((p) => p.functionResponse));
    check("a tool call goes back with its thought signature, and its result under the same id", modelTurn?.parts?.[0]?.thoughtSignature === "sig-mock" && resultTurn?.parts?.[0]?.functionResponse?.id === modelTurn.parts[0].functionCall.id, [modelTurn?.parts?.[0], resultTurn?.parts?.[0]]);

    const wrongKey = await admin.post("/api/providers", { name: "Gemini, wrong key", adapter: "gemini", baseUrl: `${MOCK}/gemini/v1beta`, apiKey: "AIzaSyWRONG-0123456789-not-a-real-key" });
    const wrongTest = await admin.post(`/api/providers/${wrongKey.data?.provider?.id}/test`);
    check("a wrong key: the provider's message, without the key", wrongTest.data?.ok === false && /API key not valid/.test(wrongTest.data?.error ?? "") && !/AIzaSyWRONG/.test(JSON.stringify(wrongTest.data)), wrongTest.data);

    begin("Custom HTTP adapter");
    const config = {
      chat: { path: "/api/chat", method: "POST", body: { model: "{{model}}", messages: "{{messages}}", stream: false, options: { temperature: "{{temperature}}" } }, responsePath: "message.content", promptTokensPath: "prompt_eval_count", completionTokensPath: "eval_count", errorPath: "error" },
      models: { path: "/api/tags", listPath: "models", idPath: "name" },
      healthPath: "/health",
    };
    const noConfig = await admin.post("/api/providers", { name: "Custom, empty", adapter: "custom-http", baseUrl: `${MOCK}/custom`, authType: "none" });
    eq("without a configuration it is refused", noConfig.status, 400);
    const badConfig = await admin.post("/api/providers", { name: "Custom, bad", adapter: "custom-http", baseUrl: `${MOCK}/custom`, authType: "none", config: JSON.stringify({ chat: { path: "/api/chat" } }) });
    check("a configuration with a part missing says which", badConfig.status === 400 && /chat\.body/.test(badConfig.error ?? ""), badConfig.error);
    const custom = await admin.post("/api/providers", { name: "Mock custom", adapter: "custom-http", baseUrl: `${MOCK}/custom`, authType: "header", authHeaderName: "x-custom-token", apiKey: "custom-secret-token", config: JSON.stringify(config) });
    check("with one it is created", custom.status === 201 && custom.data?.provider?.config?.includes("message.content"), custom.error);
    const cp = custom.data?.provider?.id;
    check("  the connection test asks its health address", (await admin.post(`/api/providers/${cp}/test`)).data?.ok === true, null);
    eq("  its models are read where the configuration says", (await admin.post(`/api/providers/${cp}/models/discover`)).data?.models, ["llama-mock:latest", "qwen-mock:7b"]);
    const cm = (await admin.post("/api/models", { providerId: cp, modelId: "llama-mock:latest", capabilities: ["text"] })).data?.model?.id;
    await mockReset();
    const cchat = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: cm, messages: [{ role: "user", content: "Reply with the single word: ok" }], temperature: 0.2 } });
    eq("chat: the answer and the token counts are read from the response", [cchat.events.filter((e) => e.delta).map((e) => e.delta).join(""), cchat.events.find((e) => e.done)?.usage], ["ok", { promptTokens: 9, completionTokens: 5 }]);
    const sent = (await mockLog()).find((l) => l.path === "/custom/api/chat");
    eq("  the request is written as configured", [sent?.body?.model, sent?.body?.stream, sent?.body?.options?.temperature, sent?.body?.messages?.at(-1)], ["llama-mock:latest", false, 0.2, { role: "user", content: "Reply with the single word: ok" }]);
    const brokenModel = (await admin.post("/api/models", { providerId: cp, modelId: "broken", capabilities: ["text"] })).data?.model?.id;
    const cerr = await sse(admin, "/api/chat", { method: "POST", body: { modelRowId: brokenModel, messages: [{ role: "user", content: "hi" }] } });
    check("  an error in the response body is reported as one", /model 'broken' not found/.test(cerr.events.find((e) => e.error)?.error ?? ""), cerr.events);
    const cleared = await admin.patch(`/api/providers/${cp}`, { config: "" });
    eq("its configuration cannot be emptied", cleared.status, 400);

    await agent("Custo", "Customworker", { primaryModelRowId: cm, tools: ["list_files", "write_file"] });
    const cwf = await workflow("Custom tools", [{ title: "Tool: files", objective: "Would use tools.", role: "Customworker" }]);
    const cproj = await project(admin, { title: "Custom tools", workflowId: cwf });
    const crun = await runProject(admin, cproj);
    const ctask = taskOf(crun.events, 1);
    check("an agent on it answers without tools: such an API has none", ctask?.status === "succeeded" && !ctask.toolCalls && /OUTPUT of "Tool: files"/.test(ctask.artifact ?? ""), [ctask?.status, ctask?.artifact]);
  }

  // ─── The Reel, with everything ─────────────────────────────────────────────

  async function reel() {
    begin("Reel: keyframes, voice-over, final cut");
    for (const [name, role] of [["Reel Director", "Creative Director"], ["Reel Artist", "Video Artist"], ["Reel Designer", "Designer"], ["Reel Writer", "Copywriter"]]) {
      if (!ids.agents?.Clara) await agent(name, role);
    }
    const template = reelWorkflowTemplate({ scenes: 2, clipSeconds: 2, keyframes: true, voiceOver: true, voice: "alloy", join: true, subtitles: true });
    const needs = templateNeeds(template.steps);
    eq("the template: per scene a keyframe, a clip from it, a voice-over; then the cut", template.steps.map((s) => s.kind ?? "text"), ["text", "text", "image", "video", "audio", "image", "video", "audio", "render", "image", "text"]);
    eq("  what it asks of a project", [needs.tasks, needs.media], [11, 7]);
    const wf = await admin.post("/api/workflows", template);
    check("it is accepted as a workflow", wf.status === 201, wf.error);
    eq("  a clip keeps the step its picture comes from, the cut its subtitles", [wf.data?.workflow?.steps?.[3]?.media?.imageFrom, wf.data?.workflow?.steps?.[8]?.media], [3, { aspectRatio: "9:16", subtitles: true }]);
    const base = { title: "Reel with everything", goal: "A Reel about a lighthouse.", managerModelRowId: ids.models.chat, workflowId: wf.data?.workflow?.id, imageModelRowId: ids.models.img_openai, videoModelRowId: state.models["vid-real"], maxParallel: 4 };
    const noVoice = await admin.post("/api/projects", base);
    check("without a speech model the project is refused", noVoice.status === 400 && /speech model/.test(noVoice.error ?? ""), noVoice.error);
    const tooFew = await admin.post("/api/projects", { ...base, speechModelRowId: state.models.tts, maxTasks: 10 });
    check("with a task limit below its steps, too", tooFew.status === 400 && /11 steps/.test(tooFew.error ?? ""), tooFew.error);
    const created = await admin.post("/api/projects", { ...base, speechModelRowId: state.models.tts });
    check("with one it is created", created.status === 201 && created.data?.project?.speechModelRowId === state.models.tts, created.error);
    const projectId = created.data?.project?.id;

    await mockReset();
    const run = await runProject(admin, projectId);
    if (!HAS_FFMPEG) {
      check("without ffmpeg the run stops before anything is generated, and says why", run.events.at(-1)?.status === "failed" && /needs ffmpeg/.test(run.events.find((e) => e.type === "error")?.message ?? ""), run.events.find((e) => e.type === "error"));
      eq("  nothing was asked of a provider", (await mockLog()).filter((l) => l.method === "POST").length, 0);
      return;
    }
    eq("the run finishes", run.events.at(-1)?.status, "succeeded");
    const done = finished(run.events).sort((a, b) => a.seq - b.seq);
    eq("every task succeeds", done.map((t) => t.status), Array(11).fill("succeeded"));
    eq("each creative task has its file", done.map((t) => (t.assets ?? []).map((a) => `${a.kind}/${a.source}/${a.status}`).join()), ["", "", "image/provider/ready", "video/provider/ready", "audio/provider/ready", "image/provider/ready", "video/provider/ready", "audio/provider/ready", "video/render/ready", "image/provider/ready", ""]);

    const log = await mockLog();
    const videoCalls = log.filter((l) => l.method === "POST" && /\/videos$/.test(l.path));
    check("each clip starts from its keyframe: the picture is sent with the request", videoCalls.length === 2 && videoCalls.every((l) => String(l.body?.input_reference?.image_url ?? "").startsWith("data:image/png;base64,")), videoCalls.map((l) => Object.keys(l.body ?? {})));
    const speechCalls = log.filter((l) => l.path === "/openai/v1/audio/speech");
    eq("each voice-over is the agent's line, without its wrapping, in the chosen voice", speechCalls.map((l) => [l.body?.input, l.body?.voice]).sort(), [["Welcome to the lighthouse. This is Scene 1 voice-over.", "alloy"], ["Welcome to the lighthouse. This is Scene 2 voice-over.", "alloy"]]);
    const cut = done[8];
    eq("the final cut is the two clips, one after the other", [cut.assets?.[0]?.durationSeconds, cut.assets?.[0]?.mimeType], [4, "video/mp4"]);
    check("  and says what it was made from", /Joined video from 2 clips, with voice-over and subtitles \(4s\)/.test(cut.artifact ?? ""), cut.artifact);
    check("the summary knows that some results are media it cannot see", /mentions-media=true/.test(run.events.find((e) => e.type === "final")?.deliverable ?? ""), run.events.find((e) => e.type === "final"));
    const library = await admin.get(`/api/media?projectId=${projectId}`);
    eq("everything is in the project's library", library.data?.assets?.map((a) => a.kind).sort(), ["audio", "audio", "image", "image", "image", "video", "video", "video"]);

    begin("Reel: the AI Manager can plan the same kinds");
    const planned = await project(admin, { title: "Planned with voice", imageModelRowId: ids.models.img_openai, videoModelRowId: state.models["vid-real"], speechModelRowId: state.models.tts });
    await mockReset();
    await runProject(admin, planned);
    const planPrompt = (await mockLog()).find((l) => l.path.endsWith("/chat/completions") && String(l.body?.messages?.[0]?.content).includes("AI Manager of an engineering team"))?.body?.messages?.[0]?.content ?? "";
    check("the manager is offered voice-overs, pictures to start clips from, and the join", /"audio"/.test(planPrompt) && /imageFrom/.test(planPrompt) && /"kind":"render"/.test(planPrompt), planPrompt.slice(0, 200));
  }

  // ─── Skills ────────────────────────────────────────────────────────────────

  async function skills() {
    const file = (path, text) => ({ path, data: Buffer.from(text, "utf8") });
    const skillMd = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    const names = async (user = admin) => ((await user.get("/api/skills")).data?.skills ?? []).map((s) => s.name);

    begin("Skills: written down by hand");
    const style = await admin.post("/api/skills", { name: "House style", description: "How we write here.", instructions: "Short sentences.\nNo filler words." });
    eq("a skill is kept with its name, description and instructions", [style.status, style.data?.skill?.name, style.data?.skill?.description, style.data?.skill?.instructions, style.data?.skill?.enabled], [201, "House style", "How we write here.", "Short sentences.\nNo filler words.", true]);
    const styleId = style.data?.skill?.id;
    const again = await admin.post("/api/skills", { name: "  house   STYLE ", instructions: "Other words." });
    check("a second skill of the same name, in other letters, is refused", again.status === 409 && /already/.test(again.error ?? ""), again.error);
    const replaced = await admin.post("/api/skills", { name: "House style", description: "How we write here.", instructions: "Short sentences.\nNo filler words.\nNo exclamation marks.", onConflict: "replace" });
    eq("  unless it is said to replace it: the same skill, with the new text", [replaced.status, replaced.data?.replaced, replaced.data?.skill?.id, /exclamation/.test(replaced.data?.skill?.instructions ?? "")], [200, true, styleId, true]);
    eq("a skill without a name is refused", (await admin.post("/api/skills", { name: "  ", instructions: "x" })).status, 400);
    eq("a file whose path leaves the skill is refused", (await admin.post("/api/skills", { name: "Sneaky", instructions: "x", files: [{ path: "../../etc/passwd", content: "x" }] })).status, 400);
    eq("  and nothing of that skill is kept", (await names()).includes("Sneaky"), false);
    eq("only an administrator writes skills", (await bob.post("/api/skills", { name: "Mine", instructions: "x" })).status, 403);
    eq("signed out: no skills", (await ctx.anon.get("/api/skills")).status, 401);

    begin("Skills: uploaded as SKILL.md, as .skill, as .zip");
    const md = await upload(admin, "/api/skills/upload", Buffer.from(skillMd("seo-basics", "Titles and descriptions that are found. Use for any page that is published.", "# SEO basics\n\nOne H1 a page.")), "SKILL.md", "text/markdown");
    eq("a SKILL.md becomes a skill: name and description from its front matter", [md.status, md.data?.skills?.map((s) => [s.name, s.description, s.instructions, s.replaced, s.sourceName])], [201, [["seo-basics", "Titles and descriptions that are found. Use for any page that is published.", "# SEO basics\n\nOne H1 a page.", false, "SKILL.md"]]]);
    const plain = await upload(admin, "/api/skills/upload", Buffer.from("# Reply to a customer\r\n\r\nThank them first.\r\n"), "customer replies.txt", "text/plain");
    eq("a text file without front matter: the heading is the name", [plain.status, plain.data?.skills?.[0]?.name, plain.data?.skills?.[0]?.instructions], [201, "Reply to a customer", "# Reply to a customer\n\nThank them first."]);

    const packed = writeZip([
      file("brochure-layout/SKILL.md", skillMd("brochure-layout", "Lay out a brochure or a catalogue. Use when a task asks for one.", "# Brochure layout\n\nStart from the grid in references/grid.md.")),
      file("brochure-layout/references/grid.md", "# Grid\n\nTwelve columns, 8 mm gutters.\n"),
      file("brochure-layout/templates/page.html", "<main class=\"page\"></main>\n"),
      { path: "brochure-layout/assets/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00]) },
      file("__MACOSX/brochure-layout/._SKILL.md", "junk"),
    ]);
    const skillFile = await upload(admin, "/api/skills/upload", packed, "brochure-layout.skill");
    eq("a .skill is a folder with SKILL.md: its text files come with it", [skillFile.status, skillFile.data?.skills?.map((s) => [s.name, s.files.map((f) => f.path)])], [201, [["brochure-layout", ["references/grid.md", "templates/page.html"]]]]);
    check("  what is not text is left out, and said", skillFile.data?.leftOut?.length === 1 && /logo\.png: it is not text/.test(skillFile.data.leftOut[0]), skillFile.data?.leftOut);
    const brochureId = skillFile.data?.skills?.[0]?.id;

    const two = writeZip([
      file("pack/review/SKILL.md", skillMd("review-checklist", "What a review looks for.", "Name the rule that is broken.")),
      file("pack/minecraft/skill.md", "# Paper plugin\n\nUse the Paper API, Java 21.\n"),
      file("pack/minecraft/examples/plugin.yml", "name: Example\nmain: x.Example\n"),
    ]);
    const pack = await upload(admin, "/api/skills/upload", two, "pack.zip", "application/zip");
    eq("a .zip of several skill folders gives several skills", [pack.status, pack.data?.skills?.map((s) => [s.name, s.files.length]).sort()], [201, [["Paper plugin", 1], ["review-checklist", 0]]]);
    const reviewId = pack.data?.skills?.find((s) => s.name === "review-checklist")?.id;

    const clash = await upload(admin, "/api/skills/upload", writeZip([
      file("a/SKILL.md", skillMd("brand-new", "New.", "New.")),
      file("b/SKILL.md", skillMd("SEO-Basics", "Other.", "Other words.")),
    ]), "mixed.zip");
    check("an upload with a name that is taken is refused as a whole", clash.status === 409 && /seo-basics/i.test(clash.error ?? ""), clash.error);
    eq("  the skill beside it in the archive is not kept either", (await names()).includes("brand-new"), false);
    const over = await upload(admin, "/api/skills/upload?onConflict=replace", Buffer.from(skillMd("seo-basics", "Titles and descriptions that are found.", "# SEO basics\n\nOne H1 a page. A title under 60 characters.")), "seo.md");
    eq("  with onConflict=replace the skill gets the new text", [over.status, over.data?.skills?.[0]?.replaced, over.data?.skills?.[0]?.id === md.data?.skills?.[0]?.id, /60 characters/.test(over.data?.skills?.[0]?.instructions ?? "")], [201, true, true, true]);

    const picture = await upload(admin, "/api/skills/upload", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]), "skill.png", "image/png");
    check("a picture is not a skill", picture.status === 400 && /neither text nor a ZIP/.test(picture.error ?? ""), picture.error);
    const noSkill = await upload(admin, "/api/skills/upload", writeZip([file("readme.txt", "hello")]), "nothing.zip");
    check("an archive without a SKILL.md is refused, with the reason", noSkill.status === 400 && /no SKILL\.md/.test(noSkill.error ?? ""), noSkill.error);
    const escaping = writeZip([file("SKILL.md", skillMd("escape-artist", "x", "x")), file("../../outside.md", "nope"), file("inside.md", "fine")]);
    const escaped = await upload(admin, "/api/skills/upload", escaping, "escape.zip");
    eq("a file of an archive whose path leaves the folder is left out", [escaped.status, escaped.data?.skills?.[0]?.files.map((f) => f.path), /leaves the archive/.test(escaped.data?.leftOut?.[0] ?? "")], [201, ["inside.md"], true]);
    const cutOff = await upload(admin, "/api/skills/upload", packed.subarray(0, packed.length - 40), "cut.skill");
    eq("a damaged archive is refused", cutOff.status, 400);
    const tooLarge = await upload(admin, "/api/skills/upload", Buffer.alloc(SKILL_UPLOAD_MAX_BYTES + 1024, 0x61), "huge.md");
    eq("a file over the limit is refused", tooLarge.status, 413);
    eq("only an administrator uploads skills", (await upload(bob, "/api/skills/upload", Buffer.from("# Mine\n\nx\n"), "mine.md")).status, 403);
    eq("empty: refused", (await upload(admin, "/api/skills/upload", Buffer.alloc(0), "empty.md")).status, 400);

    begin("Skills: reading them back");
    const listed = await bob.get("/api/skills");
    eq("every user sees which skills there are", [listed.status, listed.data?.skills?.map((s) => s.name)], [200, ["brochure-layout", "escape-artist", "House style", "Paper plugin", "Reply to a customer", "review-checklist", "seo-basics"]]);
    check("  the list has their sizes, not their text", listed.data?.skills?.every((s) => s.instructions === undefined && s.instructionChars > 0), listed.data?.skills?.[0]);
    const one = await bob.get(`/api/skills/${brochureId}`);
    check("one skill is read with its instructions", /Start from the grid/.test(one.data?.skill?.instructions ?? ""), one.data?.skill);
    const grid = await bob.get(`/api/skills/${brochureId}/files?path=${encodeURIComponent("references/grid.md")}`);
    eq("  and each of its files", [grid.status, grid.data?.content], [200, "# Grid\n\nTwelve columns, 8 mm gutters.\n"]);
    eq("  a file it does not have: not found", (await bob.get(`/api/skills/${brochureId}/files?path=${encodeURIComponent("../../etc/passwd")}`)).status, 404);
    const download = await admin.raw(`/api/skills/${brochureId}/download`);
    const archive = readZip(Buffer.from(await download.arrayBuffer()), { maxEntries: 50, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
    eq("a skill is downloaded as a .skill that holds the same folder", [download.status, download.headers.get("content-disposition"), archive.entries.map((e) => e.path)], [200, 'attachment; filename="brochure-layout.skill"', ["brochure-layout/SKILL.md", "brochure-layout/references/grid.md", "brochure-layout/templates/page.html"]]);
    const roundTrip = await upload(admin, "/api/skills/upload?onConflict=replace", Buffer.from(await (await admin.raw(`/api/skills/${brochureId}/download`)).arrayBuffer()), "brochure-layout.skill");
    eq("  and uploaded again it is the same skill", [roundTrip.status, roundTrip.data?.skills?.map((s) => [s.id === brochureId, s.replaced, s.description, s.files.length])], [201, [[true, true, "Lay out a brochure or a catalogue. Use when a task asks for one.", 2]]]);
    const asMd = await admin.raw(`/api/skills/${styleId}/download?format=md`);
    check("  or as its SKILL.md alone", asMd.status === 200 && /^---\nname: House style\ndescription: How we write here\.\n---\n\nShort sentences\./.test(await asMd.text()));

    begin("Skills: given to agents and to teams");
    const stylist = await agent("Stylist", "Copy Stylist", { skillIds: [styleId, md.data?.skills?.[0]?.id] });
    eq("an agent keeps its skills", stylist.data?.agent?.skillIds?.length, 2);
    const reader = await agent("Layouter", "Layout Designer", { tools: ["list_files"], skillIds: [brochureId] });
    const checker = await agent("Checker", "Skill QA Reviewer", { skillIds: [reviewId] });
    eq("a skill that does not exist cannot be given", (await admin.post("/api/agents", { name: "Nobody", role: "Nobody", skillIds: ["no-such-skill"] })).status, 400);
    eq("  and no half agent is left behind", ((await admin.get("/api/agents")).data?.agents ?? []).some((a) => a.name === "Nobody"), false);
    eq("only an administrator gives skills", (await bob.patch(`/api/agents/${state.agents.Stylist}`, { skillIds: [] })).status, 403);
    const team = await admin.post("/api/teams", { name: "Print team", agentIds: [state.agents.Stylist, state.agents.Layouter, state.agents.Checker], skillIds: [styleId] });
    eq("a team keeps its skills too", [team.status, team.data?.team?.skillIds], [201, [styleId]]);
    const teamId = team.data?.team?.id;
    const usedBy = (await admin.get(`/api/skills/${styleId}`)).data?.skill;
    eq("a skill says who has it", [usedBy?.agentIds, usedBy?.teamIds], [[state.agents.Stylist], [teamId]]);
    void reader;
    void checker;

    begin("Skills: at work in a project");
    const wf = await workflow("Print", [
      { title: "Write the copy", objective: "Two lines.", role: "Copy Stylist" },
      { title: "Tool: skill", objective: "Lay it out.", role: "Layout Designer" },
      { title: "Cover picture", objective: "The cover.", role: "Layout Designer", kind: "image" },
    ]);
    const projectId = await project(admin, { title: "Print project", workflowId: wf, teamId, imageModelRowId: ids.models.img_openai });
    await mockReset();
    const run = await runProject(admin, projectId);
    eq("the run finishes", run.events.at(-1)?.status, "succeeded");
    const copy = taskOf(run.events, 1);
    check("an agent is given its own skills", /\[with:skills=House style\|seo-basics\]/.test(copy?.artifact ?? ""), copy?.artifact);
    const calls = run.events.filter((e) => e.type === "tool" && e.seq === 2).map((e) => `${e.call.name}${e.call.isError ? "!" : ""}`);
    eq("an agent with tools can read its skills: the skill, and its files", calls, ["read_skill", "read_skill!", "read_skill!", "read_skill"]);
    const layout = taskOf(run.events, 2);
    check("  a file of the skill is read as it was uploaded", /Twelve columns, 8 mm gutters/.test(layout?.artifact ?? ""), layout?.artifact);
    const log = await mockLog();
    const chats = log.filter((l) => l.path.endsWith("/chat/completions"));
    const systemOf = (title) => String(chats.find((l) => String(l.body?.messages?.[1]?.content ?? "").startsWith(`Task: ${title}`))?.body?.messages?.[0]?.content ?? "");
    const layoutSystem = systemOf("Tool: skill");
    check("  its own skill comes first, then the team's, each in full", layoutSystem.indexOf("### Skill: brochure-layout") > 0 && layoutSystem.indexOf("### Skill: brochure-layout") < layoutSystem.indexOf("### Skill: House style") && /Start from the grid in references\/grid\.md\./.test(layoutSystem) && /No exclamation marks\./.test(layoutSystem), layoutSystem.slice(0, 900));
    check("  the files of a skill are named, to be read with the tool", /Files of this skill: references\/grid\.md \(\d+ B\), templates\/page\.html \(\d+ B\)\. Read one with read_skill/.test(layoutSystem), layoutSystem.slice(0, 1200));
    const toolResults = chats.flatMap((l) => (l.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)));
    check("  a path that leaves the skill is refused, and so is another agent's skill", toolResults.some((t) => /has no file "\.\.\/\.\.\/etc\/passwd"/.test(t)) && toolResults.some((t) => /You have no skill of that name\. Your skills: brochure-layout; House style\./.test(t)), toolResults);
    const coverSystem = systemOf("Cover picture");
    check("a task that writes a picture's prompt is given the skills as well", /### Skill: brochure-layout/.test(coverSystem) && !/read_skill/.test(coverSystem), coverSystem.slice(0, 600));
    const detail = (await admin.get(`/api/projects/${projectId}`)).data?.project;
    check("the reviewer reviews by its skills, and by the team's", /\[by:review-checklist\|House style\]/.test(detail?.reviewNotes ?? ""), detail?.reviewNotes);

    begin("Skills: the one who plans sees them");
    const planned = await project(admin, { title: "Planned print", teamId });
    await mockReset();
    await runProject(admin, planned);
    const planPrompt = String((await mockLog()).find((l) => l.path.endsWith("/chat/completions") && String(l.body?.messages?.[0]?.content).includes("AI Manager of an engineering team"))?.body?.messages?.[0]?.content ?? "");
    check("each agent is listed with what it has a skill for", /- Layouter \(Layout Designer\) \[skills: brochure-layout, House style\]/.test(planPrompt) && /- Stylist \(Copy Stylist\) \[skills: House style, seo-basics\]/.test(planPrompt), planPrompt.slice(planPrompt.indexOf("Available agents"), planPrompt.indexOf("Available agents") + 500));

    begin("Skills: switched off, changed, deleted");
    eq("a skill can be switched off", (await admin.patch(`/api/skills/${styleId}`, { enabled: false })).data?.skill?.enabled, false);
    const renamed = await admin.patch(`/api/skills/${md.data?.skills?.[0]?.id}`, { name: "House style" });
    check("a skill cannot take the name of another", renamed.status === 409, renamed.error);
    eq("only an administrator changes a skill", (await bob.patch(`/api/skills/${styleId}`, { enabled: true })).status, 403);
    const second = await runProject(admin, projectId);
    check("a skill that is off is not given, the others still are", /\[with:[^\]]*skills=seo-basics\]/.test(taskOf(second.events, 1)?.artifact ?? ""), taskOf(second.events, 1)?.artifact);
    eq("only an administrator deletes a skill", (await bob.del(`/api/skills/${brochureId}`)).status, 403);
    eq("a skill is deleted", (await admin.del(`/api/skills/${brochureId}`)).status, 200);
    eq("  the agent that had it has it no more", ((await admin.get("/api/agents")).data?.agents ?? []).find((a) => a.name === "Layouter")?.skillIds, []);
    eq("  and its files are gone with it", (await admin.get(`/api/skills/${brochureId}/files?path=references/grid.md`)).status, 404);
    const auditDb = database();
    const actions = new Set(auditDb.prepare("select distinct action from audit_logs where action like 'skill.%'").all().map((row) => row.action));
    auditDb.close();
    check("adding, replacing, changing and deleting skills is in the audit log", ["skill.create", "skill.replace", "skill.update", "skill.delete"].every((a) => actions.has(a)), [...actions].filter((a) => a.startsWith("skill")));
  }

  // ─── Accounts: the owner, and what an owner does with the others ───────────

  async function accounts() {
    begin("Accounts: roles");
    const me = (await admin.get("/api/account/me")).data?.user;
    eq("the first account is the owner", me?.role, "owner");
    const listed = await admin.get("/api/admin/users");
    const roleOf = (list, name) => (list ?? []).find((u) => u.username === name)?.role;
    eq("an owner sees every account, with its role", [listed.status, roleOf(listed.data?.users, "admin"), roleOf(listed.data?.users, "bob")], [200, "owner", "user"]);
    eq("an ordinary user does not see the accounts", (await bob.get("/api/admin/users")).status, 403);
    eq("  nor makes one", (await bob.post("/api/admin/users", { username: "mallory", email: "mallory@example.com", password: "a-long-password-0" })).status, 403);

    begin("Accounts: an owner makes one");
    const PASS = { dina: "dina-first-password-1", eko: "eko-first-password-1", ekoSet: "eko-password-set-by-owner", ekoOwn: "eko-password-of-his-own" };
    const made = await admin.post("/api/admin/users", { username: "dina", email: "Dina@Example.com", password: PASS.dina, role: "admin" });
    const dinaId = made.data?.user?.id;
    eq("the account is made with the role it was given, its email in small letters", [made.status, made.data?.user?.username, made.data?.user?.email, made.data?.user?.role, made.data?.user?.status], [201, "dina", "dina@example.com", "admin", "active"]);
    check("  the answer holds no password", !JSON.stringify(made.data).includes(PASS.dina) && !/password/i.test(JSON.stringify(made.data)), made.data);
    const dina = client();
    eq("it signs in with the password the owner gave it", (await dina.post("/api/auth/login", { identifier: "dina", password: PASS.dina })).status, 200);
    eq("  and by its email as well", (await client().post("/api/auth/login", { identifier: "DINA@example.com", password: PASS.dina })).status, 200);
    const madeUser = await admin.post("/api/admin/users", { username: "eko", email: "eko@example.com", password: PASS.eko });
    const ekoId = madeUser.data?.user?.id;
    eq("without a role, the account is an ordinary user", [madeUser.status, madeUser.data?.user?.role], [201, "user"]);
    const taken = await admin.post("/api/admin/users", { username: "dina", email: "other@example.com", password: PASS.dina });
    eq("a username that is taken is refused", [taken.status, taken.error], [409, "That username is taken"]);
    const takenEmail = await admin.post("/api/admin/users", { username: "dina2", email: "dina@example.com", password: PASS.dina });
    eq("  and so is an email", [takenEmail.status, takenEmail.error], [409, "An account with that email already exists"]);
    eq("a password that is too short is refused", (await admin.post("/api/admin/users", { username: "short", email: "short@example.com", password: "short" })).status, 400);
    eq("  and a role there is not", (await admin.post("/api/admin/users", { username: "root", email: "root@example.com", password: PASS.dina, role: "root" })).status, 400);

    begin("Accounts: an administrator sees them, and changes none");
    eq("an administrator sees the accounts", (await dina.get("/api/admin/users")).status, 200);
    const denied = await dina.patch(`/api/admin/users/${ekoId}`, { role: "admin" });
    eq("  changes no role", [denied.status, denied.error], [403, "Only an owner manages accounts"]);
    eq("  sets no password", (await dina.patch(`/api/admin/users/${ekoId}`, { password: "taken-over-by-dina-1" })).status, 403);
    eq("  makes no account", (await dina.post("/api/admin/users", { username: "frank", email: "frank@example.com", password: PASS.dina })).status, 403);
    eq("  deletes none", (await dina.del(`/api/admin/users/${ekoId}`)).status, 403);
    const dinaFlow = await dina.post("/api/workflows", { name: "Dina's flow", steps: [{ title: "One", objective: "One.", role: "Engineer" }] });
    eq("  and is an administrator of everything else: it makes a workflow, which an ordinary user does not", [dinaFlow.status, (await bob.post("/api/workflows", { name: "Bob's flow", steps: [{ title: "One", objective: "One.", role: "Engineer" }] })).status], [201, 403]);

    begin("Accounts: an owner changes one");
    const eko = client();
    await eko.post("/api/auth/login", { identifier: "eko", password: PASS.eko });
    const renamed = await admin.patch(`/api/admin/users/${ekoId}`, { username: "eko.w", email: "Eko.W@Example.com" });
    eq("its username and its email", [renamed.status, renamed.data?.user?.username, renamed.data?.user?.email], [200, "eko.w", "eko.w@example.com"]);
    eq("  it stays signed in, under its new name", (await eko.get("/api/account/me")).data?.user?.username, "eko.w");
    eq("  the old name signs in no more", (await client().post("/api/auth/login", { identifier: "eko", password: PASS.eko })).status, 401);
    const clash = await admin.patch(`/api/admin/users/${ekoId}`, { username: "bob" });
    eq("a name another account has is refused", [clash.status, clash.error], [409, "That username is taken"]);
    eq("  and so is an email", (await admin.patch(`/api/admin/users/${ekoId}`, { email: "bob@example.com" })).status, 409);
    eq("an unknown account is not found", (await admin.patch("/api/admin/users/no-such-account", { role: "admin" })).status, 404);
    eq("nothing to change is refused", (await admin.patch(`/api/admin/users/${ekoId}`, {})).status, 400);

    const newPass = await admin.patch(`/api/admin/users/${ekoId}`, { password: PASS.ekoSet });
    check("its password: the answer does not hold it", newPass.status === 200 && !JSON.stringify(newPass.data).includes(PASS.ekoSet), newPass.data);
    eq("  the account is signed out everywhere", (await eko.get("/api/account/me")).status, 401);
    eq("  the old password signs in no more", (await client().post("/api/auth/login", { identifier: "eko.w", password: PASS.eko })).status, 401);
    eq("  the new one does", (await eko.post("/api/auth/login", { identifier: "eko.w", password: PASS.ekoSet })).status, 200);

    const promoted = await admin.patch(`/api/admin/users/${ekoId}`, { role: "owner" });
    eq("its role: a second owner", [promoted.status, promoted.data?.user?.role], [200, "owner"]);
    eq("  who manages accounts at once, without signing in again", (await eko.patch(`/api/admin/users/${dinaId}`, { role: "user" })).data?.user?.role, "user");
    eq("  (and gives the role back)", (await eko.patch(`/api/admin/users/${dinaId}`, { role: "admin" })).data?.user?.role, "admin");
    eq("  back to an ordinary user", (await admin.patch(`/api/admin/users/${ekoId}`, { role: "user" })).data?.user?.role, "user");
    eq("  who manages none any more", (await eko.patch(`/api/admin/users/${dinaId}`, { role: "user" })).status, 403);

    const off = await admin.patch(`/api/admin/users/${ekoId}`, { status: "disabled" });
    eq("its status: switched off", [off.status, off.data?.user?.status], [200, "disabled"]);
    eq("  it is signed out", (await eko.get("/api/account/me")).status, 401);
    eq("  and cannot sign in", (await client().post("/api/auth/login", { identifier: "eko.w", password: PASS.ekoSet })).status, 401);
    eq("  switched on again, it can", [(await admin.patch(`/api/admin/users/${ekoId}`, { status: "active" })).data?.user?.status, (await eko.post("/api/auth/login", { identifier: "eko.w", password: PASS.ekoSet })).status], ["active", 200]);
    eq("signed out everywhere by the owner", [(await admin.patch(`/api/admin/users/${ekoId}`, { signOut: true })).status, (await eko.get("/api/account/me")).status], [200, 401]);

    // A second factor that was lost: set as the app would have it, then taken off by the owner.
    const tfa = database();
    tfa.prepare("UPDATE users SET two_factor_enabled = 1, two_factor_secret = 'not-a-real-secret', two_factor_confirmed_at = ? WHERE id = ?").run(Date.now(), ekoId);
    tfa.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES ('rc-eko-1', ?, 'hash', ?)").run(ekoId, Date.now());
    tfa.close();
    const asked = await client().post("/api/auth/login", { identifier: "eko.w", password: PASS.ekoSet });
    eq("an account with two-factor sign-in is asked for its code", asked.data?.twoFactorRequired, true);
    const reset = await admin.patch(`/api/admin/users/${ekoId}`, { resetTwoFactor: true });
    eq("  the owner switches a lost second factor off", [reset.status, reset.data?.user?.twoFactorEnabled], [200, false]);
    const tfaAfter = database();
    const leftOver = tfaAfter.prepare("SELECT two_factor_secret AS secret, (SELECT count(*) FROM recovery_codes WHERE user_id = users.id) AS codes FROM users WHERE id = ?").get(ekoId);
    tfaAfter.close();
    eq("  its secret and its recovery codes are gone", leftOver, { secret: null, codes: 0 });
    const plain = await eko.post("/api/auth/login", { identifier: "eko.w", password: PASS.ekoSet });
    eq("  and it signs in with its password alone", [plain.status, plain.data?.twoFactorRequired ?? false], [200, false]);

    begin("Accounts: what an owner cannot do");
    const own = await admin.patch(`/api/admin/users/${me?.id}`, { role: "user" });
    eq("change their own role", [own.status, own.error], [400, "You cannot change your own role or status"]);
    eq("switch themselves off", (await admin.patch(`/api/admin/users/${me?.id}`, { status: "disabled" })).status, 400);
    const ownName = await admin.patch(`/api/admin/users/${me?.id}`, { username: "boss" });
    eq("change their own name here: that is done under Settings, with their password", [ownName.status, ownName.error], [400, "Change your own account under Settings"]);
    eq("delete themselves", [(await admin.del(`/api/admin/users/${me?.id}`)).status, (await admin.get("/api/account/me")).data?.user?.role], [400, "owner"]);

    begin("Accounts: one's own username, email and password");
    const wrong = await eko.patch("/api/account/me", { currentPassword: "not-the-password", username: "eko" });
    eq("without the current password nothing changes", [wrong.status, wrong.error, (await eko.get("/api/account/me")).data?.user?.username], [401, "Password is incorrect", "eko.w"]);
    const mine = await eko.patch("/api/account/me", { currentPassword: PASS.ekoSet, username: "eko", email: "Eko@Example.com" });
    eq("with it, the username and the email are changed", [mine.status, mine.data?.user?.username, mine.data?.user?.email, mine.data?.passwordChanged], [200, "eko", "eko@example.com", false]);
    eq("a name that is taken is refused", (await eko.patch("/api/account/me", { currentPassword: PASS.ekoSet, username: "bob" })).status, 409);
    eq("nothing to change is refused", (await eko.patch("/api/account/me", { currentPassword: PASS.ekoSet })).status, 400);
    eq("a role cannot be given to oneself this way", [(await eko.patch("/api/account/me", { currentPassword: PASS.ekoSet, username: "eko", role: "owner" })).status, (await eko.get("/api/account/me")).data?.user?.role], [200, "user"]);
    const elsewhere = client();
    await elsewhere.post("/api/auth/login", { identifier: "eko", password: PASS.ekoSet });
    const changed = await eko.patch("/api/account/me", { currentPassword: PASS.ekoSet, newPassword: PASS.ekoOwn });
    eq("a new password of one's own", [changed.status, changed.data?.passwordChanged], [200, true]);
    eq("  this session goes on", (await eko.get("/api/account/me")).status, 200);
    eq("  the others are signed out", (await elsewhere.get("/api/account/me")).status, 401);
    eq("  the old password signs in no more, the new one does", [(await client().post("/api/auth/login", { identifier: "eko", password: PASS.ekoSet })).status, (await client().post("/api/auth/login", { identifier: "eko", password: PASS.ekoOwn })).status], [401, 200]);
    eq("signed out, nobody changes an account", (await client().patch("/api/account/me", { currentPassword: PASS.ekoOwn, username: "ghost" })).status, 401);

    begin("Accounts: an owner deletes one");
    const gone = await admin.del(`/api/admin/users/${dinaId}`);
    eq("the account is deleted", [gone.status, ((await admin.get("/api/admin/users")).data?.users ?? []).some((u) => u.username === "dina")], [200, false]);
    eq("  it is signed out, and signs in no more", [(await dina.get("/api/account/me")).status, (await client().post("/api/auth/login", { identifier: "dina", password: PASS.dina })).status], [401, 401]);
    check("  what it made is still there", ((await admin.get("/api/workflows")).data?.workflows ?? []).some((w) => w.name === "Dina's flow"), null);
    eq("  its name is free again", (await admin.post("/api/admin/users", { username: "dina", email: "dina@example.com", password: PASS.dina })).status, 201);
    const again = ((await admin.get("/api/admin/users")).data?.users ?? []).find((u) => u.username === "dina");
    eq("  (and that account is deleted too)", (await admin.del(`/api/admin/users/${again?.id}`)).status, 200);
    eq("the account of the earlier checks is deleted as well", (await admin.del(`/api/admin/users/${ekoId}`)).status, 200);

    begin("Accounts: the pages, and the audit log");
    const pageOf = async (who, path) => {
      const res = await who.raw(path);
      return { status: res.status, html: res.status === 200 ? await res.text() : "", location: res.headers.get("location") };
    };
    const usersPage = await pageOf(admin, "/dashboard/users");
    check("Users & Roles, for an owner: the accounts, and a way to make one", usersPage.status === 200 && usersPage.html.includes("New account") && usersPage.html.includes("bob@example.com"), usersPage.status);
    const forUser = await pageOf(bob, "/dashboard/users");
    check("  an ordinary user is sent away from it", forUser.status === 307 && /\/dashboard$/.test(forUser.location ?? ""), [forUser.status, forUser.location]);
    const settings = await pageOf(bob, "/dashboard/settings");
    check("Settings lets a person change their username, email and password", settings.status === 200 && settings.html.includes("Username and email") && settings.html.includes("Change the password"), settings.status);
    const auditDb = database();
    const rows = auditDb.prepare("SELECT action, metadata FROM audit_logs WHERE action LIKE 'admin.user.%' OR action LIKE 'account.%'").all();
    auditDb.close();
    const actions = new Set(rows.map((row) => row.action));
    check("making, changing and deleting accounts is in the audit log", ["admin.user.create", "admin.user.update", "admin.user.delete", "account.updated", "account.password.changed", "account.update.denied"].every((a) => actions.has(a)), [...actions]);
    check("  no password is", !rows.some((row) => Object.values(PASS).some((p) => String(row.metadata ?? "").includes(p))), null);
    check("  what changed is, by name", rows.some((row) => row.action === "admin.user.update" && /"changed":\["username","email"\]/.test(row.metadata ?? "")) && rows.some((row) => row.action === "admin.user.update" && /"changed":\["password"\]/.test(row.metadata ?? "") && /"signedOut":true/.test(row.metadata ?? "")), rows.filter((row) => row.action === "admin.user.update").map((row) => row.metadata).slice(0, 4));
  }

  // ─── Model checks (v1.8) ─────────────────────────────────────

  async function health() {
    const openai = ids.providers.openai;
    const force = (modelId, status, times) => fetch(`${MOCK}/__force?model=${modelId}&status=${status}${times ? `&times=${times}` : ""}`);
    const round = (modelIds) => admin.post("/api/models/health", { modelIds, wait: true });
    const byName = async () => new Map(((await admin.get("/api/models")).data?.models ?? []).map((m) => [m.modelId, m]));
    const apiKey = (await admin.post("/api/account/api-keys", { name: "Model checks", scopes: ["chat"], rateLimitPerMinute: 600 })).data?.secret;
    const listedModels = async () => (await (await v1("/models", { key: apiKey })).json().catch(() => null))?.data ?? [];
    const listed = async () => (await listedModels()).map((m) => m.name);
    const asks = async (modelId) => (await mockLog()).filter((l) => l.method === "POST" && l.body?.model === modelId && l.body?.messages?.[0]?.content === "Reply with the single word: ok").length;
    const page = async (who, path) => {
      const res = await who.raw(path);
      return res.status === 200 ? await res.text() : "";
    };

    begin("Model checks: a model that fails is left out of the lists");
    const steady = await model("health-steady", openai, "health-steady", ["text"]);
    const flip = await model("health-switch", openai, "health-switch", ["text"]);
    const brief = await model("health-brief", openai, "health-brief", ["text"]);
    const picture = await model("health-picture", openai, "img-health", ["image_generation"]);
    const status = await admin.get("/api/models/health");
    eq("an administrator reads how the check is set", [status.status, status.data?.health?.automatic, status.data?.health?.running], [200, false, false]);
    eq("an ordinary user does not", (await bob.get("/api/models/health")).status, 403);
    eq("  and starts none", (await bob.post("/api/models/health", {})).status, 403);
    check("a model that was never checked is offered", (await listed()).includes("health-switch") && (await page(admin, "/dashboard/chat")).includes("health-switch"), await listed());
    const publicId = (await listedModels()).find((m) => m.name === "health-switch")?.id;

    await force("health-switch", 403);
    await mockReset();
    const first = await round([steady.id, flip.id, brief.id, picture.id]);
    eq("a round asks the models it is given, each for one word", [first.status, first.data?.round?.checked, first.data?.round?.passed, first.data?.round?.failed], [200, 3, 2, 1]);
    check("  and says which model it took away", first.data?.round?.hidden?.length === 1 && /^health-switch · /.test(first.data.round.hidden[0]) && first.data.round.restored.length === 0, first.data?.round);
    let now = await byName();
    eq("the model that failed is marked, with what its provider said", [now.get("health-switch")?.lastTestStatus, now.get("health-switch")?.hidden, now.get("health-switch")?.checkFailures, /Provider responded 403/.test(now.get("health-switch")?.lastTestError ?? "")], ["error", true, 1, true]);
    eq("  the ones that answered are not", [now.get("health-steady")?.lastTestStatus, now.get("health-steady")?.hidden, now.get("health-brief")?.hidden], ["ok", false, false]);
    eq("  a refusal is not asked a second time", await asks("health-switch"), 1);
    eq("a model that makes pictures is not checked, and stays in the lists", [now.get("img-health")?.lastTestStatus, now.get("img-health")?.hidden, (await mockLog()).some((l) => l.body?.model === "img-health")], [null, false, false]);
    const names = await listed();
    check("the public list of models leaves the failing one out", names.includes("health-steady") && !names.includes("health-switch"), names.filter((n) => n.startsWith("health-")));
    const chatPage = await page(admin, "/dashboard/chat");
    check("  and so does the list a chat offers", chatPage.includes("health-steady") && !chatPage.includes("health-switch"), null);
    const modelsPage = await page(admin, "/dashboard/models");
    check("the Models page says that it is left out, and how the check is set", modelsPage.includes("left out of the lists") && /\d+ models? (is|are) left out now\./.test(modelsPage) && modelsPage.includes("The automatic check is switched off") && modelsPage.includes("Check all now"), /[^>]{0,40}left out now[^<]{0,10}/.exec(modelsPage)?.[0]);
    await v1("/chat/completions", { key: apiKey, method: "POST", body: { model: publicId, messages: [{ role: "user", content: "Hello, health." }] } });
    check("a request that names the failing model is still passed on to its provider", (await mockLog()).some((l) => l.body?.model === "health-switch" && l.body?.messages?.some((m) => m.content === "Hello, health.")), publicId);

    begin("Model checks: a busy moment does not take a model away");
    await force("health-brief", 429, 1);
    await mockReset();
    const busy = await round([brief.id]);
    eq("a model that worked and is limited for a moment is asked once more, and stays", [busy.data?.round?.passed, busy.data?.round?.hidden?.length, await asks("health-brief")], [1, 0, 2]);
    await force("health-brief", 429);
    const limited = await round([brief.id]);
    now = await byName();
    eq("limited both times, it is left out", [limited.data?.round?.failed, limited.data?.round?.hidden?.length, now.get("health-brief")?.hidden, now.get("health-brief")?.checkFailures], [1, 1, true, 1]);
    await mockReset();
    await round([brief.id]);
    now = await byName();
    eq("a failing model is asked once in a round, and its failures are counted", [await asks("health-brief"), now.get("health-brief")?.checkFailures], [1, 2]);

    begin("Model checks: a model that answers again is back");
    await force("health-switch", 200);
    await force("health-brief", 200);
    const back = await round([flip.id, brief.id]);
    now = await byName();
    eq("the round says which models it gave back", [back.data?.round?.passed, back.data?.round?.restored?.length, back.data?.round?.hidden?.length], [2, 2, 0]);
    eq("  they are offered again, their failures forgotten", [now.get("health-switch")?.hidden, now.get("health-switch")?.checkFailures, now.get("health-brief")?.hidden, (await listed()).includes("health-switch")], [false, 0, false, true]);
    await force("health-switch", 500);
    const byHand = await admin.post(`/api/models/${flip.id}/test`, {});
    now = await byName();
    eq("the Test button counts as a check: a model that fails it is left out", [byHand.data?.ok, now.get("health-switch")?.hidden, (await listed()).includes("health-switch")], [false, true, false]);
    await force("health-switch", 200);
    const byHandAgain = await admin.post(`/api/models/${flip.id}/test`, {});
    eq("  and one that passes it is back at once", [byHandAgain.data?.ok, (await byName()).get("health-switch")?.hidden], [true, false]);

    begin("Model checks: the automatic choice of a model");
    const cheap = await model("health-cheap", openai, "health-cheap", ["text"], { inputPricePerMTok: 0.000001, outputPricePerMTok: 0.000001 });
    await agent("Autopick", "Autopicker", { routingMode: "auto" });
    const autoWf = await workflow("Autopick", [{ title: "Pick", objective: "Answers.", role: "Autopicker" }]);
    const firstModelOf = async (title) => {
      const id = await project(admin, { title, workflowId: autoWf, managerModelRowId: ids.models.chat });
      const run = await runProject(admin, id);
      const attempts = (await admin.get(`/api/projects/${id}/attempts`)).data?.attempts ?? [];
      return [taskOf(run.events, 1)?.status, attempts[0]?.modelId];
    };
    eq("an agent that takes the cheapest model takes it while it answers", await firstModelOf("Autopick, the cheapest answers"), ["succeeded", "health-cheap"]);
    await force("health-cheap", 403);
    await round([cheap.id]);
    await mockReset();
    const second = await firstModelOf("Autopick, the cheapest fails");
    check("a model that failed its check is not chosen", second[0] === "succeeded" && second[1] !== "health-cheap" && !(await mockLog()).some((l) => l.body?.model === "health-cheap"), second);
    // Out of the way of whatever chooses a model after this.
    await admin.patch(`/api/models/${cheap.id}`, { enabled: false });
    await force("health-cheap", 200);

    begin("Model checks: an agent keeps the model it is set to");
    await force("health-switch", 403);
    await round([flip.id]);
    const keeper = await agent("Health keeper", "Keeper", { primaryModelRowId: flip.id, fallbackModelRowId: ids.models.chat });
    eq("an agent can be set to a failing model by its ID, and keeps it", [keeper.status, keeper.data?.agent?.primaryModelRowId], [201, flip.id]);
    const auditDb = database();
    const actions = auditDb.prepare("SELECT action, actor_user_id AS actor, metadata FROM audit_logs WHERE action LIKE 'model.health.%'").all();
    auditDb.close();
    const count = (action) => actions.filter((row) => row.action === action).length;
    check("the audit log has the rounds, and each model that was taken away or given back", count("model.health.run") === 7 && count("model.health.hidden") === 4 && count("model.health.restored") === 2 && actions.every((row) => row.actor), [count("model.health.run"), count("model.health.hidden"), count("model.health.restored")]);
    eq("a round is refused when its models are not named properly", (await admin.post("/api/models/health", { modelIds: [] })).status, 400);
  }

  // ─── The tokens of an account (v1.8) ───────────────────────────────────

  async function tokens() {
    const PASS = "tokens-first-password-1";
    const yours = (used, limit) => `Your token balance is used up: ${used} of ${limit} tokens used. An owner of this installation can raise your limit.`;
    const ofProject = (used, limit) =>
      `The token balance of the account this project belongs to is used up: ${used} of ${limit} tokens used. An owner of this installation can raise its limit.`;
    /** What the account used, may use, and has left. */
    const balance = async (who) => {
      const u = (await who.get("/api/account/me")).data?.user;
      return [u?.tokensUsed, u?.tokenLimit, u?.tokensLeft];
    };
    const hi = { modelRowId: ids.models.chat, messages: [{ role: "user", content: "hi" }] };
    /** One chat: the mock provider counts 20 tokens in and 10 out for it. */
    const say = (who) => sse(who, "/api/chat", { method: "POST", body: hi });
    const answered = (chat) => chat.events.some((e) => e.done);
    const signIn = async (name) => {
      const who = client();
      await who.post("/api/auth/login", { identifier: name, password: PASS });
      return who;
    };
    const make = (username, extra = {}) => admin.post("/api/admin/users", { username, email: `${username}@example.com`, password: PASS, ...extra });
    const lastStatus = (events) => events.filter((e) => e.type === "status").at(-1)?.status;
    /** What reached a provider to be answered: not the worker asking after a video of an earlier check. */
    const asked = async () => (await mockLog()).filter((l) => l.method === "POST").map((l) => l.path);

    begin("Tokens: what an account may use");
    const owner = (await admin.get("/api/account/me")).data?.user;
    check("an owner is not held to a limit, and what it used is counted", owner?.tokenLimit === null && owner?.tokensLeft === null && Number.isInteger(owner?.tokensUsed), [owner?.tokenLimit, owner?.tokensLeft, owner?.tokensUsed]);
    const tia = client();
    const registered = await tia.post("/api/auth/register", { username: "tia", email: "tia@example.com", password: PASS });
    eq("an account that registers may use ten million tokens", [registered.status, registered.data?.user?.tokenLimit, registered.data?.user?.tokensUsed, registered.data?.user?.tokensLeft], [201, 10_000_000, 0, 10_000_000]);
    const uli = await make("uli");
    eq("  and so may one that an owner makes", [uli.status, uli.data?.user?.tokenLimit, uli.data?.user?.tokensLeft], [201, 10_000_000, 10_000_000]);
    const veraMade = await make("vera", { tokenLimit: 100 });
    const veraId = veraMade.data?.user?.id;
    eq("  unless the owner gives it another limit", [veraMade.status, veraMade.data?.user?.tokenLimit, veraMade.data?.user?.tokensLeft], [201, 100, 100]);
    const wrong = [];
    for (const [i, tokenLimit] of [-1, 1.5, "many", 10_000_000_000_000].entries()) wrong.push((await make(`wrong${i}`, { tokenLimit })).status);
    eq("a limit that is no whole number of tokens, or too large, is refused", wrong, [400, 400, 400, 400]);

    begin("Tokens: work uses them up");
    const vera = await signIn("vera");
    const first = await say(vera);
    eq("a chat is answered, and what it used is counted", [answered(first), await balance(vera)], [true, [30, 100, 70]]);
    await say(vera);
    await say(vera);
    eq("  chat after chat", await balance(vera), [90, 100, 10]);
    const last = await say(vera);
    eq("the chat that uses the last tokens is answered in full, and counted in full", [answered(last), await balance(vera)], [true, [120, 100, 0]]);

    begin("Tokens: with none left, new work is refused");
    await agent("Counter", "Counter");
    const countWf = await workflow("Count to three", [
      { title: "One", objective: "Say one.", role: "Counter" },
      { title: "Two", objective: "Say two.", role: "Counter", dependsOn: [1] },
      { title: "Three", objective: "Say three.", role: "Counter", dependsOn: [2] },
    ]);
    const veraProject = await project(vera, { title: "Vera counts", workflowId: countWf, maxParallel: 1 });
    const keyMade = await vera.post("/api/account/api-keys", { name: "Vera's key", scopes: ["chat", "embeddings", "media", "projects"] });
    const key = keyMade.data?.secret;
    await mockReset();
    const refused = await vera.post("/api/chat", hi);
    eq("a chat: 402, and it says how much was used, of how much, and who can change that", [refused.status, refused.code, refused.error], [402, "token_limit_reached", yours("120", "100")]);
    const image = await vera.post("/api/media/images", { modelRowId: ids.models.img_openai, prompt: "A lamp." });
    const speech = await vera.post("/api/media/speech", { modelRowId: state.models.tts, text: "Hello." });
    const video = await vera.post("/api/media/videos", { modelRowId: ids.models.vid_openai, prompt: "A lamp." });
    eq("  an image, a voice-over and a video", [image.status, speech.status, video.status, image.code, video.error], [402, 402, 402, "token_limit_reached", yours("120", "100")]);
    const start = await runProject(vera, veraProject);
    let startError = null;
    try {
      startError = JSON.parse(start.error ?? "").error;
    } catch {
      /* not JSON */
    }
    eq("  a run of a project", [start.status, startError?.code, startError?.message], [402, "token_limit_reached", yours("120", "100")]);
    eq("    which is left as it was: no run was made", (await vera.get(`/api/projects/${veraProject}/runs`)).data?.runs?.length, 0);
    const apiChat = await v1json("/chat/completions", { key, method: "POST", body: { model: "chat-mini", messages: [{ role: "user", content: "hi" }] } });
    eq("the public API with the account's key: 402, in the shape API clients read", [keyMade.status, apiChat.status, apiChat.error?.type, apiChat.error?.code, apiChat.error?.message], [201, 402, "insufficient_quota", "token_limit_reached", yours("120", "100")]);
    const apiOthers = [
      await v1json("/embeddings", { key, method: "POST", body: { model: "text-embedding-3-small", input: "x" } }),
      await v1json("/audio/speech", { key, method: "POST", body: { model: "tts-1", input: "Hello.", voice: "alloy" } }),
      await v1json("/images/generations", { key, method: "POST", body: { model: "Mock OpenAI-style/img-ok", prompt: "x" } }),
      await v1json(`/projects/${veraProject}/runs`, { key, method: "POST" }),
    ];
    eq("  embeddings, speech, an image and a run as well", apiOthers.map((res) => [res.status, res.error?.code]), Array(4).fill([402, "token_limit_reached"]));
    eq("  what costs nothing is still answered: the list of models", (await v1json("/models", { key })).status, 200);
    const col = (await vera.post("/api/knowledge", { name: "Vera's notes", embeddingModelRowId: state.models.embed })).data?.collection?.id;
    const doc = await vera.post(`/api/knowledge/${col}/documents`, { title: "Lamps", text: "Every lamp has a wick. The wick is trimmed every four hours." });
    const kept = await until(async () => (await vera.get(`/api/knowledge/${col}`)).data, (d) => d?.documents?.length > 0 && d.documents.every((x) => x.embeddingStatus !== "pending"));
    const found = await vera.post("/api/knowledge/search", { query: "wick", collectionIds: [col] });
    check(
      "a document is kept and found by its words; it is not embedded, and says why",
      doc.status === 201 && kept?.documents?.[0]?.embeddingStatus === "failed" && (kept.documents[0].error ?? "").includes("Your token balance is used up") && found.data?.hits?.[0]?.documentTitle === "Lamps",
      [doc.status, kept?.documents?.[0]?.embeddingStatus, kept?.documents?.[0]?.error, found.data?.hits?.[0]?.documentTitle],
    );
    eq("nothing of all this was asked of a provider", await asked(), []);
    eq("what the account used is what it was", await balance(vera), [120, 100, 0]);
    const bell = (await vera.get("/api/notifications")).data?.notifications ?? [];
    const told = bell.filter((n) => n.title === "Your token balance is used up");
    check("the account was told once, when its last tokens went", told.length === 1 && told[0].level === "warning" && told[0].body.startsWith("120 of 100 tokens used."), told);

    begin("Tokens: an owner sets the limit, and nobody else");
    const wimMade = await make("wim", { role: "admin" });
    const wim = await signIn("wim");
    const seen = ((await wim.get("/api/admin/users")).data?.users ?? []).find((u) => u.username === "vera");
    eq("an administrator sees what an account used and may use", [seen?.tokensUsed, seen?.tokenLimit, seen?.tokensLeft], [120, 100, 0]);
    const byAdmin = await wim.patch(`/api/admin/users/${veraId}`, { tokenLimit: 5_000_000 });
    eq("  and changes no limit", [byAdmin.status, byAdmin.error], [403, "Only an owner manages accounts"]);
    eq("  its own neither", (await wim.patch(`/api/admin/users/${wimMade.data?.user?.id}`, { tokenLimit: 5_000_000 })).status, 403);
    eq("  and makes no account with one", (await wim.post("/api/admin/users", { username: "zed", email: "zed@example.com", password: PASS, tokenLimit: 5_000_000 })).status, 403);
    eq("an ordinary user changes none: not its own, not another's", [(await vera.patch(`/api/admin/users/${veraId}`, { tokenLimit: 5_000_000 })).status, (await bob.patch(`/api/admin/users/${veraId}`, { tokenLimit: 5_000_000 })).status], [403, 403]);
    const bySettings = await vera.patch("/api/account/me", { currentPassword: PASS, tokenLimit: 5_000_000, tokensUsed: 0 });
    eq("  and Settings takes no limit", [bySettings.status, await balance(vera)], [400, [120, 100, 0]]);
    const raised = await admin.patch(`/api/admin/users/${veraId}`, { tokenLimit: 1_000 });
    eq("an owner raises the limit: what was used stays counted", [raised.status, raised.data?.user?.tokensUsed, raised.data?.user?.tokenLimit, raised.data?.user?.tokensLeft], [200, 120, 1_000, 880]);
    const again = await say(vera);
    eq("  and the account works again at once", [answered(again), await balance(vera)], [true, [150, 1_000, 850]]);
    const lowered = await admin.patch(`/api/admin/users/${veraId}`, { tokenLimit: 150 });
    eq("an owner lowers the limit: at what was used, nothing is left", [lowered.data?.user?.tokensLeft, (await vera.post("/api/chat", hi)).status], [0, 402]);
    const none = await admin.patch(`/api/admin/users/${veraId}`, { tokenLimit: 0 });
    eq("  a limit of 0 is a limit", [none.status, none.data?.user?.tokenLimit, none.data?.user?.tokensLeft], [200, 0, 0]);
    const wrongChange = [];
    for (const tokenLimit of [-1, 1.5, "many", null, 10_000_000_000_000]) wrongChange.push((await admin.patch(`/api/admin/users/${veraId}`, { tokenLimit })).status);
    eq("a limit that is no whole number of tokens, or too large, is refused", [wrongChange, (await balance(vera))[1]], [[400, 400, 400, 400, 400], 0]);
    eq("the limit of an account there is not: 404", (await admin.patch("/api/admin/users/no-such-account", { tokenLimit: 5 })).status, 404);
    const xena = await make("xena", { role: "owner", tokenLimit: 500 });
    const xenaId = xena.data?.user?.id;
    eq("another owner is not held to a limit either", [xena.status, xena.data?.user?.tokenLimit, xena.data?.user?.tokensLeft], [201, null, null]);
    const forOwner = await admin.patch(`/api/admin/users/${xenaId}`, { tokenLimit: 5 });
    eq("  and none can be set for it", [forOwner.status, forOwner.error], [400, "An owner is not held to a token limit: there is none to set"]);
    const demoted = await admin.patch(`/api/admin/users/${xenaId}`, { role: "user" });
    eq("an owner that becomes a user is held to the limit of its account", [demoted.status, demoted.data?.user?.tokenLimit], [200, 500]);
    const promoted = await admin.patch(`/api/admin/users/${xenaId}`, { role: "admin", tokenLimit: 700 });
    eq("  a role and a limit are changed in one go", [promoted.status, promoted.data?.user?.role, promoted.data?.user?.tokenLimit], [200, "admin", 700]);

    begin("Tokens: a run stops when they are used up");
    const yanMade = await make("yan", { tokenLimit: 50 });
    const yanId = yanMade.data?.user?.id;
    const yan = await signIn("yan");
    const yanProject = await project(yan, { title: "Yan counts", workflowId: countWf, maxParallel: 1 });
    await mockReset();
    const run = await runProject(yan, yanProject);
    const third = taskOf(run.events, 3);
    eq(
      "the tasks run while there are tokens; the one after is not started, and says why",
      [taskOf(run.events, 1)?.status, taskOf(run.events, 2)?.status, third?.status, third?.error],
      ["succeeded", "succeeded", "cancelled", ofProject("60", "50")],
    );
    const result = run.events.find((e) => e.type === "final")?.deliverable ?? "";
    check("  the run ends for a look, and its result says that it was not put together, and why", lastStatus(run.events) === "review" && result.includes("was not put together into one deliverable") && result.includes(ofProject("60", "50")), [lastStatus(run.events), result]);
    eq("  nothing more was asked of a model: two tasks, no summary, no review", [(await asked()).length, await balance(yan)], [2, [60, 50, 0]]);
    const yanBell = (await yan.get("/api/notifications")).data?.notifications ?? [];
    const look = yanBell.find((n) => n.title === "Run needs a look: Yan counts");
    check("  the account is told: about the run, and that its tokens are used up", (look?.body ?? "") === `1 of 3 tasks did not succeed. ${ofProject("60", "50")}` && yanBell.filter((n) => n.title === "Your token balance is used up").length === 1, yanBell.map((n) => [n.title, n.body]));
    const parse = (text) => {
      try {
        return JSON.parse(text ?? "").error?.message;
      } catch {
        return text;
      }
    };
    const restart = await runProject(yan, yanProject);
    const byOwner = await runProject(admin, yanProject);
    eq("a new run is refused: to the account itself, and to an administrator who starts its project", [restart.status, parse(restart.error), byOwner.status, parse(byOwner.error)], [402, yours("60", "50"), 402, ofProject("60", "50")]);
    // 100 more: the three tasks use 90, and putting the result together the last 10 and 20 beyond.
    await admin.patch(`/api/admin/users/${yanId}`, { tokenLimit: 160 });
    const second = await runProject(yan, yanProject);
    eq(
      "when putting the result together uses the last tokens, the run is not reviewed, and says so",
      [finished(second.events).map((e) => e.status), lastStatus(second.events), second.events.find((e) => e.type === "review")?.notes, await balance(yan)],
      [["succeeded", "succeeded", "succeeded"], "review", `(Not reviewed. ${ofProject("180", "160")})`, [180, 160, 0]],
    );
    await admin.patch(`/api/admin/users/${yanId}`, { tokenLimit: 1_000 });
    const third2 = await runProject(yan, yanProject);
    eq("with tokens enough, a run is whole: its tasks, its result, its review", [finished(third2.events).map((e) => e.status), lastStatus(third2.events), await balance(yan)], [["succeeded", "succeeded", "succeeded"], "succeeded", [330, 1_000, 670]]);

    begin("Tokens: what is not counted");
    const before = (await balance(wim))[0];
    const tested = await wim.post(`/api/models/${ids.models.chat}/test`, {});
    eq("a check of a model by an administrator is the installation's: it is counted for nobody", [tested.data?.ok, (await balance(wim))[0]], [true, before]);
    await fetch(`${MOCK}/__force?model=chat-mini&status=500&times=1`);
    const failedChat = await say(yan);
    check("a chat that the provider failed is not counted", failedChat.events.some((e) => e.error) && (await balance(yan))[0] === 330, [failedChat.events, await balance(yan)]);

    begin("Tokens: the pages, and the audit log");
    const pageOf = async (who, path) => {
      const res = await who.raw(path);
      return res.status === 200 ? await res.text() : `status ${res.status}`;
    };
    const usersPage = await pageOf(admin, "/dashboard/users");
    check("Users & Roles shows what each account used and may use", usersPage.includes(">Tokens</th>") && usersPage.includes('data-tokens="vera"') && usersPage.includes("used up") && usersPage.includes("No limit"), usersPage.length);
    check("  an owner has a way to change a limit there", usersPage.includes('aria-label="Change the token limit of vera"') && !usersPage.includes('aria-label="Change the token limit of admin"'), null);
    const forAdmin = await pageOf(wim, "/dashboard/users");
    check("  an administrator sees the numbers, and no way to change them", forAdmin.includes('data-tokens="vera"') && !forAdmin.includes("Change the token limit of"), null);
    const veraSettings = await pageOf(vera, "/dashboard/settings");
    check("Settings shows an account its tokens: used, limit, left", veraSettings.includes('id="token-balance"') && />150</.test(veraSettings) && veraSettings.includes("An owner of this installation sets the limit"), null);
    check("  an account with none left is told on every page", veraSettings.includes('id="tokens-used-up"') && (await pageOf(vera, "/dashboard")).includes("Your token balance is used up"), null);
    const tiaHome = await pageOf(tia, "/dashboard");
    check("  one with tokens sees how many are left, and no warning", tiaHome.includes('id="tokens-left"') && tiaHome.includes("10M tokens left") && !tiaHome.includes('id="tokens-used-up"'), null);
    const ownerSettings = await pageOf(admin, "/dashboard/settings");
    check("  an owner sees what it used, and that it has no limit", ownerSettings.includes('id="token-balance"') && ownerSettings.includes("No limit") && !ownerSettings.includes('id="tokens-left"'), null);
    const auditDb = database();
    const rows = auditDb.prepare("SELECT action, actor_user_id AS actor, target_id AS target, metadata FROM audit_logs WHERE action IN ('admin.user.create', 'admin.user.update', 'account.tokens.used_up')").all();
    auditDb.close();
    const meta = (row) => JSON.parse(row.metadata ?? "{}");
    const changes = rows.filter((row) => row.action === "admin.user.update" && row.target === veraId && meta(row).changed?.includes("tokenLimit")).map((row) => [meta(row).tokenLimitBefore, meta(row).tokenLimit, meta(row).tokensUsed]);
    eq("every change of a limit is in the audit log: from what, to what, and what was used by then", changes, [[100, 1_000, 120], [1_000, 150, 150], [150, 0, 150]]);
    check("  with who changed it", rows.filter((row) => row.action === "admin.user.update" && row.target === veraId).every((row) => row.actor === owner?.id), null);
    eq("  the limit an account was made with is there too", meta(rows.find((row) => row.action === "admin.user.create" && row.target === veraId) ?? {}).tokenLimit, 100);
    const usedUp = (id) => rows.filter((row) => row.action === "account.tokens.used_up" && row.target === id).map((row) => [meta(row).tokensUsed, meta(row).tokenLimit]);
    eq("  and so is each time an account used its last tokens", [usedUp(veraId), usedUp(yanId)], [[[120, 100]], [[60, 50], [180, 160]]]);

    // The accounts of these checks go, so that the lists after them are what they were.
    const gone = [];
    for (const name of ["tia", "uli", "vera", "wim", "xena", "yan"]) {
      const id = ((await admin.get("/api/admin/users")).data?.users ?? []).find((u) => u.username === name)?.id;
      gone.push((await admin.del(`/api/admin/users/${id}`)).status);
    }
    eq("the accounts of these checks are deleted", gone, [200, 200, 200, 200, 200, 200]);
  }

  const parts = { speech, render, knowledge, tools, skills, runs, notifications: notificationChecks, api: publicApi, adapters, reel, accounts, health, tokens };
  for (const [name, part] of Object.entries(parts)) {
    if (wants(name)) await part();
  }
}
