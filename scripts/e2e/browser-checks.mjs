// Checks of the dashboard in a real browser, after checks.mjs has filled the
// database. Not part of a plain `npm run test:e2e`, because it needs a
// headless Chromium that this project does not depend on:
//
//   mkdir /some/folder && cd /some/folder && npm init -y
//   npm install puppeteer-core @sparticuz/chromium
//   cd <this repository>
//   E2E_BROWSER=/some/folder npm run test:e2e
//
//   SHOTS=<folder>   also save a screenshot of each page looked at
//
// It signs in as the administrator the checks registered and clicks through
// what a person would: the forms open, the buttons do what they say, a run is
// followed live, and no page logs an error or scrolls sideways on a phone.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = process.env.E2E_APP_URL ?? "http://127.0.0.1:3100";
const MODULES = process.env.BROWSER_MODULES;
const SHOTS = process.env.SHOTS;
const HAS_FFMPEG = process.env.E2E_FFMPEG === "1";

if (!MODULES) {
  console.error("BROWSER_MODULES is not set: the folder where puppeteer-core and @sparticuz/chromium are installed.");
  process.exit(2);
}
// Both packages are loaded from that folder, whichever module format they ship.
const resolveFrom = createRequire(join(MODULES, "package.json"));
async function load(name) {
  let file;
  try {
    file = resolveFrom.resolve(name);
  } catch {
    console.error(`${name} is not installed in ${MODULES}. Run there: npm install puppeteer-core @sparticuz/chromium`);
    process.exit(2);
  }
  const mod = await import(pathToFileURL(file).href);
  return mod.default ?? mod;
}
// The Chromium build is chosen by the Lambda runtime it is told about.
process.env.AWS_LAMBDA_JS_RUNTIME ??= `nodejs${process.versions.node.split(".")[0]}.x`;
const chromium = await load("@sparticuz/chromium");
const puppeteer = await load("puppeteer-core");

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
    const shown = detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
    failures.push(`${section}: ${name}${shown ? `\n         ${shown}` : ""}`);
    console.log(`  FAIL ${name}${shown ? `  →  ${shown}` : ""}`);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A reader in another time zone, with another language, than the server: what
// the server renders first must still be what the browser makes of the page.
const READER_ZONE = "Asia/Jakarta";
const READER_LANGUAGE = "id-ID";

const browser = await puppeteer.launch({
  args: [...chromium.args, "--autoplay-policy=no-user-gesture-required", `--lang=${READER_LANGUAGE}`],
  executablePath: await chromium.executablePath(),
  headless: true,
  env: { ...process.env, LANG: `${READER_LANGUAGE.replace("-", "_")}.UTF-8`, LANGUAGE: READER_LANGUAGE },
});
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900 });
await page.emulateTimezone(READER_ZONE);
await page.setExtraHTTPHeaders({ "accept-language": `${READER_LANGUAGE},id;q=0.9,en;q=0.5` });
await page.evaluateOnNewDocument((language) => {
  Object.defineProperty(navigator, "language", { get: () => language });
  Object.defineProperty(navigator, "languages", { get: () => [language, "id"] });
}, READER_LANGUAGE);

/** Everything a page logged as an error, with where it happened. */
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(`${new URL(page.url()).pathname}: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  // A refused request is checked where it is expected, not here.
  if (/Failed to load resource/.test(text)) return;
  pageErrors.push(`${new URL(page.url()).pathname}: ${text}`);
});
page.on("dialog", (dialog) => void dialog.accept());

let shot = 0;
async function snap(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`) });
}

async function open(path) {
  await page.goto(`${APP}${path}`, { waitUntil: "networkidle2", timeout: 60_000 });
}
const text = () => page.evaluate(() => document.body.innerText);
const has = async (needle) => (await text()).includes(needle);

/** Wait until the page's text holds `needle` (a string or a pattern). */
async function waitText(needle, timeout = 20_000) {
  try {
    await page.waitForFunction(
      (n, isPattern) => (isPattern ? new RegExp(n).test(document.body.innerText) : document.body.innerText.includes(n)),
      { timeout },
      needle instanceof RegExp ? needle.source : needle,
      needle instanceof RegExp,
    );
    return true;
  } catch {
    return false;
  }
}

/** Click the first button (or link, or tab) of the page's content whose text matches. */
async function clickText(pattern, { within = "main", tag = "button, a, [role=tab]" } = {}) {
  const source = pattern instanceof RegExp ? pattern.source : `^\\s*${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`;
  const flags = pattern instanceof RegExp ? pattern.flags : "";
  const clicked = await page.evaluate(
    (scope, selector, src, fl) => {
      const root = document.querySelector(scope);
      if (!root) return false;
      const re = new RegExp(src, fl);
      const el = [...root.querySelectorAll(selector)].find((e) => re.test(e.textContent ?? "") && !e.disabled && e.offsetParent !== null);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    within,
    tag,
    source,
    flags,
  );
  return clicked;
}

/** Replace what a field holds. */
async function fill(selector, value) {
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.focus(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (value) await page.type(selector, value, { delay: 0 });
}

/** The session's own API, for looking things up and for setting a scene. */
async function api(path, init = {}) {
  return page.evaluate(
    async (p, i) => {
      const res = await fetch(p, { ...i, headers: { "content-type": "application/json", ...(i.headers ?? {}) } });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, data };
    },
    path,
    init,
  );
}

const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  // ─── Sign in ───────────────────────────────────────────────────────────────
  begin("Browser: sign in");
  await open("/login");
  await fill("#identifier", "admin");
  await fill("#password", "correct-horse-battery");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), page.click('button[type="submit"]')]);
  check("the administrator signs in", page.url().endsWith("/dashboard"), page.url());
  check("the navigation has Knowledge", await page.$('a[href="/dashboard/knowledge"]') !== null);
  const reader = await page.evaluate(() => ({
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    number: (1234567.5).toLocaleString(),
    hour: new Date(Date.UTC(2026, 0, 1, 0, 0)).getHours(),
  }));
  check("the browser is in another time zone than the server", reader.zone === READER_ZONE && reader.hour === 7, reader);
  // Without this the checks below would not notice text that depends on the reader's language.
  check("  and writes numbers another way", reader.number === "1.234.567,5", reader);

  // ─── The bell ──────────────────────────────────────────────────────────────
  begin("Browser: notifications");
  await page.waitForSelector('button[aria-label^="Notifications"]');
  const unreadBefore = await page.$eval('button[aria-label^="Notifications"]', (b) => b.getAttribute("aria-label"));
  check("the bell says how many are unread", /\d+ unread/.test(unreadBefore ?? ""), unreadBefore);
  await page.click('button[aria-label^="Notifications"]');
  check("it opens a list of what happened", await waitText("Run finished"), (await text()).slice(0, 200));
  await sleep(400); // the list fades in
  await snap("bell");
  await clickText("Mark all read", { within: "header" });
  await sleep(600);
  const unreadAfter = await page.$eval('button[aria-label^="Notifications"]', (b) => b.getAttribute("aria-label"));
  check("  marking all as read clears the count", unreadAfter === "Notifications", unreadAfter);
  await page.keyboard.press("Escape");
  check("  Escape closes it", (await page.$('[role="dialog"][aria-label="Notifications"]')) === null);

  // ─── Providers and models ──────────────────────────────────────────────────
  begin("Browser: providers and models");
  await open("/dashboard/providers");
  await clickText(/Add provider/);
  await page.waitForSelector("#p-adapter");
  await page.select("#p-adapter", "gemini");
  check("choosing Gemini fills in its address", (await page.$eval("#p-baseurl", (e) => e.value)) === "https://generativelanguage.googleapis.com/v1beta");
  check("  and explains where the key goes", await has("x-goog-api-key"));
  await page.select("#p-adapter", "custom-http");
  await page.waitForSelector("#p-config");
  const config = await page.$eval("#p-config", (e) => e.value);
  check("choosing Custom HTTP shows a configuration to start from", config.includes('"responsePath": "message.content"'), config.slice(0, 80));
  check("  no adapter is called planned any more", !(await has("planned")) && !(await has("isn’t implemented")));
  await snap("provider-form");

  await open("/dashboard/models");
  await clickText(/Add model/);
  await page.waitForSelector("#m-type");
  await page.select("#m-type", "speech");
  check("a speech model has a price per million characters", (await page.$("#m-chars-price")) !== null);
  await page.select("#m-type", "embedding");
  check("an embedding model has no media price", (await page.$("#m-chars-price")) === null && (await page.$("#m-img-price")) === null);
  check("the list shows the speech price", await has("/1M characters"));

  // ─── Agents ────────────────────────────────────────────────────────────────
  begin("Browser: agents");
  await open("/dashboard/agents");
  check("an agent shows its tools, knowledge and memory", (await has("9 tools")) && (await has("knowledge")) && (await has("memory")), null);
  await clickText(/Add agent/);
  await page.waitForSelector("#a-name");
  const toolBoxes = await page.$$eval('fieldset input[type="checkbox"]', (boxes) => boxes.length);
  check("the form offers the tools one by one", toolBoxes >= 9, toolBoxes);
  await fill("#a-name", "Browser Agent");
  await fill("#a-role", "Browser Tester");
  await page.evaluate(() => {
    const label = [...document.querySelectorAll("fieldset label")].find((l) => l.textContent.includes("Read web pages"));
    label?.querySelector("input")?.click();
  });
  check("  the step limit opens once a tool is chosen", await page.$eval("#a-steps", (e) => !e.disabled));
  await snap("agent-form");
  await clickText("Add agent", { tag: 'button[type="submit"]' });
  check("the new agent is listed with its tool", await waitText("Browser Agent") && (await waitText("1 tool")), null);
  await clickText(/Notes/);
  check("an agent's notes can be opened", await waitText(/What .* remembers/), null);
  await snap("agent-notes");

  // ─── Workflows ─────────────────────────────────────────────────────────────
  begin("Browser: workflows");
  await open("/dashboard/workflows");
  await clickText(/New workflow/);
  await page.waitForSelector("#w-reel-scenes");
  check("the template says what it asks of a project", await has("7 steps, 4 generated files per run"));
  for (const option of ["Keyframes", "Voice-over", "Join into one video"]) {
    await page.evaluate((name) => {
      const label = [...document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(name));
      label?.querySelector("input")?.click();
    }, option);
  }
  check("  and counts again when options are ticked", await waitText("14 steps, 10 generated files per run"), null);
  await clickText(/Use template/);
  check("the template fills in the steps", await waitText("Step 14"), null);
  const kinds = await page.$$eval('select[aria-label$="delivers"]', (list) => list.map((s) => s.value));
  check("  with keyframes, voice-overs and the final cut", kinds.filter((k) => k === "audio").length === 3 && kinds.includes("render") && kinds.filter((k) => k === "image").length === 4, kinds);
  const from = await page.$$eval('select[aria-label$="starts from the image of step"]', (list) => list.map((s) => s.value));
  check("  each clip starts from its keyframe", JSON.stringify(from) === JSON.stringify(["3", "6", "9"]), from);
  await snap("workflow-template");
  await clickText("Create workflow", { tag: 'button[type="submit"]' });
  check("the workflow is saved and says what it makes", await waitText("3 videos · 4 images · 3 voice-overs · joined into one video"), null);

  // ─── Projects ──────────────────────────────────────────────────────────────
  begin("Browser: a new project");
  await open("/dashboard/projects");
  await clickText(/New project/);
  await page.waitForSelector("#p-wf");
  // The workflow made above: three scenes with everything is 14 steps and 10 generated files.
  const reelOption = await page.$$eval("#p-wf option", (options) => options.find((o) => o.textContent.includes("Reel (3 scenes, keyframes, voice-over, joined"))?.value);
  check("the workflow can be chosen for a project", Boolean(reelOption), await page.$$eval("#p-wf option", (options) => options.map((o) => o.textContent)));
  if (!reelOption) throw new Error("the workflow made in the browser is not offered to a new project");
  await page.select("#p-wf", reelOption);
  check("choosing the workflow asks for a speech model", (await page.$("#p-tts")) !== null && (await page.$eval("#p-tts", (e) => e.value)) !== "");
  await clickText(/advanced settings/);
  await page.waitForSelector("#p-maxtask");
  check("  and makes room for its steps and its media", (await page.$eval("#p-maxtask", (e) => e.value)) === "14" && (await page.$eval("#p-maxmedia", (e) => e.value)) === "10", [await page.$eval("#p-maxtask", (e) => e.value), await page.$eval("#p-maxmedia", (e) => e.value)]);
  check("  memory of earlier runs can be switched on", await has("Remember earlier runs"));
  await snap("project-form");

  begin("Browser: a project page");
  const projects = (await api("/api/projects")).data.projects;
  const toolsProject = projects.find((p) => p.title === "Tools project");
  const detachProject = projects.find((p) => p.title === "Detach");
  if (toolsProject) {
    await open(`/dashboard/projects/${toolsProject.id}`);
    check("a task shows how many tool calls it took", await has("5 tool calls"));
    await clickText(/5 tool calls/);
    check("  and what they were, with their results", (await waitText("write_file")) && (await waitText("Saved notes/plan.md")), null);
    await snap("project-tools");
  } else {
    check("the tools project exists (run the full checks first)", false);
  }
  if (detachProject) {
    await open(`/dashboard/projects/${detachProject.id}`);
    check("the page lists the project's runs", (await has("Runs")) && (await has("schedule")) && (await has("started by hand")), null);
    await clickText(/View what it delivered/);
    check("  an earlier run still has what it delivered", await waitText("FINAL DELIVERABLE"), null);
    await clickText(/Add schedule/);
    await page.waitForSelector("#s-cron");
    check("a schedule shows when it runs next, before it is saved", await waitText(/Every day at 08:00\. Next:/), null);
    await fill("#s-cron", "* * * * *");
    check("  one that runs too often says so", await waitText("at most every 5 minutes"), null);
    await fill("#s-cron", "30 7 * * 1-5");
    await fill("#s-zone", "Asia/Jakarta");
    await clickText(/Save schedule/);
    check("  it is saved and described in words", await waitText("Every weekday at 07:30"), null);
    await snap("project-schedule");

    // A run started elsewhere is followed by an open page, and by a page opened later.
    await clickText(/^\s*Re-run\s*$/);
    check("a run started from the page is followed live", await waitText(/working…|waiting to start/, 10_000), null);
    await open(`/dashboard/projects/${detachProject.id}`);
    check("  a page opened while it runs picks it up", await waitText(/working…|succeeded/, 10_000), null);
    const finished = await waitText("Final deliverable", 60_000);
    check("  and shows the result when it ends, without a reload", finished && (await has("succeeded")), null);
    await snap("project-run");
  }

  // ─── Creative Studio ───────────────────────────────────────────────────────
  begin("Browser: Creative Studio");
  await open("/dashboard/studio");
  const tabs = await page.$$eval('[role="tab"]', (list) => list.map((t) => t.textContent.trim()));
  check("the tabs: image, video, voice, join", JSON.stringify(tabs) === JSON.stringify(["Image", "Video", "Voice", "Join clips"]), tabs);
  await clickText("Voice", { tag: "[role=tab]" });
  await page.waitForSelector("#st-speech");
  await fill("#st-speech", "Hello from the browser. This is a voice-over made by a click.");
  await page.select("#st-model", await page.$$eval("#st-model option", (o) => o.find((x) => x.textContent.startsWith("tts-1"))?.value ?? o[0].value));
  await clickText(/Generate voice/);
  check("a voice-over is generated and can be played", await page.waitForSelector("audio[src]", { timeout: 30_000 }).then(() => true, () => false));
  await snap("studio-voice");

  await clickText("Video", { tag: "[role=tab]" });
  await clickText(/From the library/);
  const pickable = await page.$$eval('button[aria-label^="Start from:"]', (list) => list.length);
  check("a video can start from an image of the library", pickable > 0, pickable);
  await page.click('button[aria-label^="Start from:"]');
  check("  the chosen image is shown with the request", await waitText("Starts from this image"), null);
  await snap("studio-video");

  await clickText("Join clips", { tag: "[role=tab]" });
  if (HAS_FFMPEG) {
    check("joining offers the clips of the library", await waitText("Tick the clips in the order they should play"), null);
    // The two clips the render checks generated: real video, unlike the mock's other files.
    const picked = await page.evaluate(() => {
      const offered = [...document.querySelectorAll("form ul button[aria-pressed]")];
      const real = ["clip one", "clip two"].map((name) => offered.find((b) => b.textContent.includes(name))).filter(Boolean);
      for (const button of real) button.click();
      return real.length;
    });
    check("  two real clips are in the library", picked === 2, picked);
    await snap("studio-join");
    await clickText(/Join 2 clips/);
    check("  the joined video appears, in progress", await waitText(/Joining the clips…|joined video/, 15_000), null);
    // The library is newest first: the first card is the one just asked for.
    const ready = await page
      .waitForFunction(
        () => {
          const first = document.querySelector("li.card");
          return Boolean(first && first.textContent.includes("joined video") && first.querySelector("video[src]") && !first.textContent.includes("in progress"));
        },
        { timeout: 120_000 },
      )
      .then(() => true, () => false);
    check("  and plays when the worker has made it, without a reload", ready, await page.evaluate(() => document.querySelector("li.card")?.textContent?.slice(0, 200)));
    const playable = await page.evaluate(async () => {
      const video = document.querySelector("li.card video[src]");
      if (!video) return { missing: true };
      // A Chromium built without H.264 cannot say anything about the file.
      if (!video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) return { unsupported: true };
      video.preload = "metadata";
      if (video.readyState < 1) {
        video.load();
        await Promise.race([
          new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true })),
          new Promise((resolve) => setTimeout(resolve, 15_000)),
        ]);
      }
      return { seconds: Math.round(video.duration * 10) / 10, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState };
    });
    if (playable.unsupported) {
      console.log("  note this browser cannot play H.264; the joined file itself is checked by the render checks");
    } else {
      // Two clips of two seconds each, in the upright shape of the first.
      check("  it is the two clips, one after the other", Math.abs(playable.seconds - 4) < 0.5 && playable.height > playable.width, playable);
    }
  } else {
    check("without ffmpeg, the Join tab says what is missing", await waitText("it is not installed"), null);
  }

  // ─── Knowledge and chat ────────────────────────────────────────────────────
  begin("Browser: knowledge");
  await open("/dashboard/knowledge");
  await clickText(/New collection/);
  await fill("#k-name", "Browser notes");
  await clickText("Create collection", { tag: 'button[type="submit"]' });
  check("a collection is created and opened", await waitText("No document yet"), null);
  await clickText(/Paste text/);
  await fill("#k-doc-title", "Opening hours");
  await fill("#k-doc-text", "The lighthouse museum is open from ten to four, every day except Monday.");
  await clickText(/Add document/);
  check("pasted text becomes a document", await waitText("1 passage"), null);
  const fileInput = await page.$('input[type="file"]');
  const upload = join(tmpdir(), `browser-upload-${Date.now()}.md`);
  writeFileSync(upload, "# Tickets\n\nA ticket for the museum costs five euros. Children enter free.\n");
  await fileInput.uploadFile(upload);
  check("a file can be uploaded", await waitText(/browser-upload-\d+\.md/), null);
  await fill("#k-query", "when is the museum open");
  await clickText(/^\s*Search\s*$/);
  check("a question finds the passage", await waitText("by words"), null);
  await snap("knowledge");

  begin("Browser: chat with knowledge");
  await open("/dashboard/chat");
  // The first model of the list is one the mock refuses on purpose.
  await page.select("main select", await page.$$eval("main select option", (options) => options.find((o) => o.textContent.startsWith("chat-mini"))?.value ?? ""));
  await clickText(/^\s*Knowledge/, { tag: "button" });
  await page.evaluate(() => {
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Browser notes"));
    label?.querySelector("input")?.click();
  });
  await page.type("textarea[placeholder^='Message']", "What does a ticket cost?");
  await clickText(/^\s*Send\s*$/);
  check("the answer is based on the documents", await waitText("From your documents [1]"), null);
  await clickText(/Show the \d+ passages?/);
  check("  and the passages that were looked up can be read", await waitText("A ticket for the museum costs five euros"), null);
  await snap("chat-knowledge");

  // ─── Settings ──────────────────────────────────────────────────────────────
  begin("Browser: API keys and the webhook");
  await open("/dashboard/settings");
  await clickText(/New key/);
  await fill("#ak-name", "From the browser");
  await clickText("Create key", { tag: 'button[type="submit"]' });
  await page.waitForSelector('[data-testid="secret-value"]', { timeout: 10_000 });
  const secret = await page.$eval('[data-testid="secret-value"]', (e) => e.textContent.trim());
  check("a key is created and shown once", /^xn_[A-Za-z0-9_-]{40,}$/.test(secret), secret.slice(0, 6));
  check("  with an example of how to use it", await has("/api/v1/chat/completions"));
  const works = await page.evaluate(async (key) => (await fetch("/api/v1/models", { headers: { authorization: `Bearer ${key}` }, credentials: "omit" })).status, secret);
  check("  the key works", works === 200, works);
  await snap("settings-key");
  await open("/dashboard/settings");
  check("after a reload only its first characters are shown", (await has(`${secret.slice(0, 10)}…`)) && !(await has(secret)), null);

  // ─── Server status ─────────────────────────────────────────────────────────
  begin("Browser: server status");
  await open("/dashboard/observability");
  check("the background worker is reported as running", (await has("Background worker")) && (await has("Running")), null);
  check("ffmpeg is reported as it is", HAS_FFMPEG ? await has("Can join clips and burn subtitles in") : await has("Not installed"), null);
  check("the sandbox and the search service are reported", (await has("Configured")) && (await has("Brave Search")), null);
  await snap("observability");

  // ─── A phone ───────────────────────────────────────────────────────────────
  begin("Browser: on a phone");
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
  for (const path of ["/dashboard/studio", "/dashboard/knowledge", "/dashboard/agents", "/dashboard/settings", "/dashboard/workflows", detachProject ? `/dashboard/projects/${detachProject.id}` : "/dashboard/projects"]) {
    await open(path);
    const overflow = await sideways();
    check(`${path.replace(/[0-9a-f-]{36}/, "<id>")} does not scroll sideways`, overflow <= 1, `${overflow}px`);
  }
  await snap("phone-project");
  await open("/dashboard/studio");
  await snap("phone-studio");

  // ─── Every page, as the server renders it ──────────────────────────────────
  begin("Browser: every page");
  await page.setViewport({ width: 1360, height: 900 });
  const pages = [
    "/dashboard",
    "/dashboard/projects",
    "/dashboard/agents",
    "/dashboard/workflows",
    "/dashboard/chat",
    "/dashboard/studio",
    "/dashboard/knowledge",
    "/dashboard/providers",
    "/dashboard/models",
    "/dashboard/usage",
    "/dashboard/observability",
    "/dashboard/audit",
    "/dashboard/users",
    "/dashboard/settings",
    "/dashboard/settings/security",
    ...(detachProject ? [`/dashboard/projects/${detachProject.id}`, `/dashboard/projects/${detachProject.id}/workspace`] : []),
    ...(toolsProject ? [`/dashboard/projects/${toolsProject.id}`, `/dashboard/projects/${toolsProject.id}/workspace`] : []),
  ];
  let opened = 0;
  for (const path of pages) {
    const before = pageErrors.length;
    const response = await page.goto(`${APP}${path}`, { waitUntil: "networkidle2", timeout: 60_000 });
    // Time for the page to come alive: that is when a difference would be reported.
    await sleep(300);
    const fine = response?.status() === 200 && pageErrors.length === before;
    if (fine) opened++;
    else check(`${path.replace(/[0-9a-f-]{36}/, "<id>")} opens without an error`, false, { status: response?.status(), errors: pageErrors.slice(before, before + 3) });
  }
  check(`all ${pages.length} pages open, and the browser agrees with what the server rendered`, opened === pages.length, `${opened} of ${pages.length}`);
  await open("/dashboard/users");
  const joined = await page.$$eval("tbody time", (list) => list.map((t) => [t.getAttribute("datetime"), t.textContent]));
  // Browsers and Node.js do not agree on the kind of space before "AM".
  const plain = (value) => String(value).replace(/\s+/gu, " ");
  const localOk =
    joined.length > 0 &&
    joined.every(([iso, shown]) => {
      const local = new Date(iso).toLocaleString("en-US", { timeZone: READER_ZONE, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return plain(shown) === plain(local);
    });
  check("dates are shown in the reader's time zone, not the server's", localOk, joined.slice(0, 2));

  begin("Browser: errors");
  check("no page logged an error", pageErrors.length === 0, pageErrors.slice(0, 8));
} catch (err) {
  failures.push(`${section}: the browser run stopped: ${err?.stack ?? err}`);
  console.log(`  FAIL the browser run stopped: ${err?.stack ?? err}`);
  await snap("stopped").catch(() => undefined);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed (browser)`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
