// A local stand-in for image / video providers, used by `npm run test:e2e`.
// It answers in the three request styles the app speaks (openai, openrouter,
// xai), plus chat completions for the agents of a project run. A second port
// plays "another origin" (a CDN): the app must never send the API key there.
// What it does is chosen by the model id of the request (img-ok, img-fail,
// vid-slow, …).
//
//   node scripts/e2e/mock-provider.mjs [apiPort=4010] [cdnPort=4011]
//
// REAL_VIDEO=<file> serves that file as every finished video, to try playback
// in a browser by hand.
//
// This mock is written from the providers' public documentation. Passing
// against it shows the app is consistent with that reading of the docs; it is
// not a test against the real services.
import { readFileSync } from "node:fs";
import http from "node:http";
import zlib from "node:zlib";

const API_PORT = Number(process.argv[2] ?? 4010);
const CDN_PORT = Number(process.argv[3] ?? 4011);
const KEY = "sk-mock-0123456789abcdefghijklmnopqrstuvwxyz-KEY";
const CDN = `http://127.0.0.1:${CDN_PORT}`;

// ─── Files ───────────────────────────────────────────────────────────────────

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real, valid PNG: a vertical gradient from `top` to `bottom`. */
function png(width, height, top, bottom = top) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const colour = top.map((c, i) => Math.round(c + (bottom[i] - c) * t));
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(colour, 1 + x * 3);
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** Not a playable video: an MP4 header followed by filler, `size` bytes long. */
function mp4(size, fill) {
  const head = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const body = Buffer.alloc(Math.max(0, size - head.length), fill);
  return Buffer.concat([head, body]);
}

const PNG_A = png(360, 640, [27, 35, 64], [245, 181, 68]);
const PNG_B = png(480, 480, [96, 165, 250], [17, 20, 26]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
// REAL_VIDEO=<file>: serve that file as every finished video, so a browser can
// play what the app stored. Without it, a 300,000-byte stand-in is served.
const MP4 = process.env.REAL_VIDEO ? readFileSync(process.env.REAL_VIDEO) : mp4(300_000, 0x2a);

// ─── State ───────────────────────────────────────────────────────────────────

/** Every request either port received, for the test to inspect. */
let log = [];
const jobs = new Map();
let counter = 0;

function record(server, req, body) {
  log.push({
    server,
    method: req.method,
    path: req.url,
    authorization: req.headers.authorization ?? null,
    xApiKey: req.headers["x-api-key"] ?? null,
    range: req.headers.range ?? null,
    body,
  });
}

function send(res, status, payload, headers = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": Buffer.isBuffer(payload) ? "application/octet-stream" : "application/json",
    "content-length": data.length,
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(text);
      }
    });
  });
}

// ─── Chat (the agents and the AI Manager of a project run) ───────────────────

function chatAnswer(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  if (system.includes("You are the AI Manager of an engineering team")) {
    // The plan. It asks for media only when the prompt offered media kinds.
    const offersImage = /"kind":"image"/.test(system);
    const offersVideo = /"kind":.*"video"/.test(system);
    const tasks = [
      { seq: 1, title: "Write the brief", objective: "Write a two-line brief.", agent: "Writer", dependsOn: [] },
      {
        seq: 2,
        title: "Poster",
        objective: "A poster for the brief.",
        agent: "Designer",
        dependsOn: [1],
        // Asked for even when not offered: the app has to turn it into text.
        kind: "image",
        media: { aspectRatio: "3:4", resolution: "not a resolution!" },
      },
      ...(offersVideo
        ? [
            {
              seq: 3,
              title: "Teaser",
              objective: "A teaser clip for the brief.",
              agent: "Designer",
              dependsOn: [1],
              kind: "video",
              media: { aspectRatio: "16:9", durationSeconds: "6" },
            },
          ]
        : []),
      { seq: 4, title: "Summary", objective: "Summarise.", agent: "Writer", dependsOn: [1, 2] },
    ];
    return `Here is the plan:\n\`\`\`json\n${JSON.stringify({ tasks, offersImage, offersVideo })}\n\`\`\``;
  }
  if (system.includes("Your deliverable for this task is the prompt for an AI")) {
    const kind = system.includes("AI video generator") ? "video" : "image";
    const deps = [...user.matchAll(/### Output of task (\d+)/g)].map((m) => m[1]).join("+") || "none";
    const title = (user.match(/^Task: (.*)$/m) ?? [])[1] ?? "?";
    // Wrapped the way models tend to wrap a prompt: lead-in, quotes, newlines.
    return `Here is the prompt:\n\n"A ${kind} of a lighthouse at dusk for '${title}', warm light,\n  slow camera push-in [deps:${deps}]"`;
  }
  if (system.includes("You are the AI Manager. Consolidate")) {
    return `FINAL DELIVERABLE. mentions-media=${/cannot (be seen|see)/i.test(system + user)}`;
  }
  if (system.includes("You are a QA/Security reviewer")) {
    return "All tasks meet their criteria.\nVERDICT: pass";
  }
  if (user.includes("Reply with the single word: ok")) return "ok";
  // An ordinary text task: say which earlier outputs the task was given.
  const deps = [...user.matchAll(/### Output of task (\d+)/g)].map((m) => m[1]).join("+") || "none";
  const title = (user.match(/^Task: (.*)$/m) ?? [])[1] ?? "?";
  return `OUTPUT of "${title}" [deps:${deps}]`;
}

function chat(req, res, body) {
  if (typeof body?.model === "string" && /^(img|vid)-/.test(body.model)) {
    return send(res, 404, { error: { message: `The model \`${body.model}\` does not support chat completions`, type: "invalid_request_error" } });
  }
  const content = chatAnswer(body);
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
  if (!body?.stream) {
    return send(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage,
    });
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const half = Math.ceil(content.length / 2);
  for (const piece of [content.slice(0, half), content.slice(half)]) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

// ─── Images ──────────────────────────────────────────────────────────────────

function images(style, res, body) {
  const model = String(body?.model ?? "");
  const n = Number(body?.n ?? 1);
  if (model === "img-fail") {
    return send(res, 400, { error: { message: "Your request was rejected by the safety system.", type: "invalid_request_error", code: "moderation_blocked" } });
  }
  if (model === "img-leak") {
    // An error that repeats the key: the app has to redact it.
    return send(res, 401, { error: { message: `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY}` } });
  }
  if (model === "img-empty") return send(res, 200, { created: 1, data: [] });
  if (model === "img-svg") return send(res, 200, { data: [{ b64_json: SVG.toString("base64") }] });
  if (model === "img-html-link") return send(res, 200, { data: [{ url: `${CDN}/cdn/page.png` }] });
  if (model === "img-evil-redirect") return send(res, 200, { data: [{ url: `${CDN}/cdn/to-metadata.png` }] });
  if (model === "img-localhost-redirect") return send(res, 200, { data: [{ url: `${CDN}/cdn/to-localhost.png` }] });
  if (model === "img-loop") return send(res, 200, { data: [{ url: `${CDN}/cdn/loop.png` }] });
  if (model === "img-too-big") return send(res, 200, { data: [{ url: `${CDN}/cdn/too-big.png` }] });
  if (model === "img-file-link") return send(res, 200, { data: [{ url: "file:///etc/passwd" }] });

  if (style === "openrouter") {
    // Links: another origin (no key), the provider's own origin (key), a
    // relative link, and a data URL.
    const variants = [
      { url: `${CDN}/cdn/redirect/a.png` },
      { url: `http://127.0.0.1:${API_PORT}/openrouter/api/v1/files/own.png` },
      { url: "/openrouter/api/v1/files/relative.png" },
      { url: `data:image/png;base64,${PNG_B.toString("base64")}` },
    ];
    return send(res, 200, {
      data: variants.slice(0, n),
      usage: { prompt_tokens: 12, completion_tokens: 1290, total_tokens: 1302, cost: 0.039 },
    });
  }
  if (style === "xai") {
    // xAI answers with a temporary link unless asked for the bytes.
    const wantsBytes = body?.response_format === "b64_json";
    return send(res, 200, {
      data: Array.from({ length: n }, () =>
        wantsBytes ? { b64_json: PNG_A.toString("base64"), revised_prompt: "revised" } : { url: `${CDN}/cdn/xai.png` },
      ),
    });
  }
  return send(res, 200, {
    created: 1,
    data: Array.from({ length: n }, (_, i) => ({ b64_json: (i % 2 ? PNG_B : PNG_A).toString("base64") })),
    usage: { input_tokens: 50, output_tokens: 4160, total_tokens: 4210 },
  });
}

// ─── Videos ──────────────────────────────────────────────────────────────────

function createVideo(style, res, body) {
  const model = String(body?.model ?? "");
  if (model === "vid-reject") {
    return send(res, 400, { error: { message: "Prompt blocked by moderation." } });
  }
  const id = `${style === "xai" ? "req" : "video"}_${++counter}_${model.replace(/[^a-z]/g, "")}`;
  // The finished file is ready after this many status requests.
  const pollsNeeded = model === "vid-slow" ? Infinity : model === "vid-instant" ? 0 : 2;
  jobs.set(id, { id, style, model, polls: 0, pollsNeeded, body });
  if (style === "xai") return send(res, 200, { request_id: id });
  if (style === "openrouter") {
    return send(res, 202, { id, polling_url: `http://127.0.0.1:${API_PORT}/openrouter/api/v1/videos/${id}`, status: "pending" });
  }
  if (model === "vid-instant") {
    return send(res, 200, { id, object: "video", model, status: "completed", progress: 100, seconds: String(body?.seconds ?? "4") });
  }
  return send(res, 200, { id, object: "video", model, status: "queued", progress: 0, seconds: String(body?.seconds ?? "4"), size: body?.size ?? "720x1280" });
}

function videoStatus(style, res, id) {
  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: { message: `Video ${id} not found` } });
  job.polls++;
  if (job.model === "vid-gone") {
    jobs.delete(id);
    return send(res, 404, { error: { message: "Job expired" } });
  }
  if (job.model === "vid-flaky" && job.polls === 1) {
    return send(res, 503, { error: { message: "Service temporarily unavailable" } });
  }
  const done = job.polls > job.pollsNeeded;
  const failed = job.model === "vid-fail" && done;

  if (style === "xai") {
    if (failed) return send(res, 200, { status: "failed", error: { message: "Content policy violation" } });
    if (!done) return send(res, 200, { status: "pending" });
    const file = job.model === "vid-html" ? "page.mp4" : `xai-${id}.mp4`;
    return send(res, 200, { status: "done", video: { url: `${CDN}/cdn/${file}`, duration: 6, respect_moderation: true }, model: job.model });
  }
  if (style === "openrouter") {
    if (failed) return send(res, 200, { id, status: "failed", error: "Generation failed: provider error" });
    if (!done) return send(res, 200, { id, status: job.polls === 1 ? "pending" : "in_progress" });
    return send(res, 200, {
      id,
      status: "completed",
      // The keyless link redirects once before the file.
      unsigned_urls: [`${CDN}/cdn/redirect/or-${id}.mp4`],
      usage: { cost: 0.5 },
    });
  }
  if (failed) return send(res, 200, { id, object: "video", status: "failed", error: { code: "moderation_blocked", message: "Blocked by our moderation system" } });
  if (!done) return send(res, 200, { id, object: "video", status: job.polls === 1 ? "queued" : "in_progress", progress: 40 });
  return send(res, 200, { id, object: "video", status: "completed", progress: 100, seconds: String(job.body?.seconds ?? "4"), size: job.body?.size ?? "720x1280" });
}

// ─── The provider API ────────────────────────────────────────────────────────

const STYLES = { "/openai/v1": "openai", "/openrouter/api/v1": "openrouter", "/xai/v1": "xai" };

const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
  if (url.pathname === "/__log") return send(res, 200, log);
  if (url.pathname === "/__reset") {
    log = [];
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__jobs") return send(res, 200, [...jobs.values()]);

  const body = req.method === "POST" ? await readBody(req) : null;
  record("api", req, body);

  const prefix = Object.keys(STYLES).find((p) => url.pathname.startsWith(`${p}/`));
  if (!prefix) return send(res, 404, { error: { message: "Unknown path" } });
  const style = STYLES[prefix];
  const path = url.pathname.slice(prefix.length);

  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return send(res, 401, { error: { message: "Missing or invalid API key" } });
  }

  if (req.method === "GET" && path === "/models") {
    return send(res, 200, { object: "list", data: [{ id: "chat-mini" }, { id: "img-ok" }, { id: "vid-ok" }] });
  }
  if (req.method === "POST" && path === "/chat/completions") return chat(req, res, body);

  // Each style has its own paths. A request in another style is a 404, which
  // is how a wrong "Image / video API" setting shows up.
  if (req.method === "POST" && path === "/images/generations" && style !== "openrouter") return images(style, res, body);
  if (req.method === "POST" && path === "/images" && style === "openrouter") return images(style, res, body);
  if (req.method === "POST" && path === "/videos" && style !== "xai") return createVideo(style, res, body);
  if (req.method === "POST" && path === "/videos/generations" && style === "xai") return createVideo(style, res, body);

  const content = path.match(/^\/videos\/([^/]+)\/content$/);
  if (req.method === "GET" && content && style === "openai") {
    const job = jobs.get(decodeURIComponent(content[1]));
    if (!job) return send(res, 404, { error: { message: "Not found" } });
    if (job.model === "vid-html") return send(res, 200, HTML, { "content-type": "video/mp4" });
    return send(res, 200, MP4, { "content-type": "video/mp4" });
  }
  const status = path.match(/^\/videos\/([^/]+)$/);
  if (req.method === "GET" && status) return videoStatus(style, res, decodeURIComponent(status[1]));

  if (req.method === "GET" && path.startsWith("/files/")) return send(res, 200, PNG_B, { "content-type": "image/png" });

  return send(res, 404, { error: { message: `No route for ${req.method} ${path} in the ${style} style` } });
});

// ─── "Another origin" ────────────────────────────────────────────────────────

const cdn = http.createServer((req, res) => {
  record("cdn", req, null);
  const path = new URL(req.url, CDN).pathname;
  if (path.startsWith("/cdn/redirect/")) {
    res.writeHead(302, { location: `/cdn/${path.slice("/cdn/redirect/".length)}` });
    return res.end();
  }
  if (path === "/cdn/to-metadata.png") {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
    return res.end();
  }
  if (path === "/cdn/to-localhost.png") {
    res.writeHead(307, { location: `http://localhost:${API_PORT}/__log` });
    return res.end();
  }
  if (path === "/cdn/loop.png") {
    res.writeHead(302, { location: "/cdn/loop.png" });
    return res.end();
  }
  if (path === "/cdn/too-big.png") {
    // Declares far more than the limit, and would send it.
    res.writeHead(200, { "content-type": "image/png", "content-length": String(300 * 1024 * 1024) });
    return res.end(PNG_A);
  }
  if (path === "/cdn/page.png" || path === "/cdn/page.mp4") {
    return send(res, 200, HTML, { "content-type": path.endsWith(".png") ? "image/png" : "video/mp4" });
  }
  if (path.endsWith(".png")) return send(res, 200, PNG_A, { "content-type": "image/png" });
  if (path.endsWith(".mp4")) return send(res, 200, MP4, { "content-type": "video/mp4" });
  return send(res, 404, { error: "not found" });
});

api.listen(API_PORT, "127.0.0.1", () => console.log(`mock provider API on http://127.0.0.1:${API_PORT}`));
cdn.listen(CDN_PORT, "127.0.0.1", () => console.log(`mock CDN on ${CDN}`));
