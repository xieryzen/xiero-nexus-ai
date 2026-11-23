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
const MOCK = process.env.E2E_MOCK_URL ?? "http://127.0.0.1:4010";
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
function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
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

/** Whether the page's content has a button (or link, or tab) with that text that can be clicked. */
async function clickableText(pattern, { within = "main", tag = "button, a, [role=tab]" } = {}) {
  return page.evaluate(
    (scope, selector, src, fl) => {
      const root = document.querySelector(scope);
      if (!root) return false;
      const re = new RegExp(src, fl);
      return [...root.querySelectorAll(selector)].some((e) => re.test(e.textContent ?? "") && !e.disabled && e.offsetParent !== null);
    },
    within,
    tag,
    pattern.source,
    pattern.flags,
  );
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
  await page.select("#p-preset", "groq");
  check(
    "starting from a known provider fills in its name, its address and how it signs in",
    (await page.$eval("#p-name", (e) => e.value)) === "Groq" &&
      (await page.$eval("#p-baseurl", (e) => e.value)) === "https://api.groq.com/openai/v1" &&
      (await page.$eval("#p-auth", (e) => e.value)) === "bearer",
  );
  check("  and says where a key is made, and when that was read", (await has("console.groq.com")) && (await has("this was read on")));
  await page.select("#p-preset", "ovhcloud");
  check(
    "a provider that takes no key is set to no key, and the name follows the choice",
    (await page.$eval("#p-name", (e) => e.value)) === "OVHcloud AI Endpoints" && (await page.$eval("#p-auth", (e) => e.value)) === "none",
  );
  await page.select("#p-preset", "");
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
  check("  a project is given no token budget: its limits are tasks, tasks at once and media", (await page.$("#p-maxtok")) === null && !(await has("Token budget")) && (await page.$("#p-par")) !== null, null);
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
    // What a run is held to stands next to its state: no budget of the project, the tokens of its account.
    const heldTo = await page.$eval("#project-tokens", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
    check("  with what its tasks used, and that an owner's run is held to no number of tokens", /^· [1-9][\d,]* tokens used by the tasks · no token limit · max \d+× parallel$/.test(heldTo ?? ""), heldTo);
    await snap("project-run");
  }

  // ─── A run that stopped at a limit ─────────────────────────────────────────
  begin("Browser: a run that stopped half way is continued");
  // Left by the checks before: one task done, one that failed at its model's
  // quota, one behind it that was not started.
  const halfProject = projects.find((p) => p.title === "Stops half way");
  if (halfProject) {
    const tasksNow = async () => (await api(`/api/projects/${halfProject.id}`)).data?.project?.tasks ?? [];
    const before = await tasksNow();
    await open(`/dashboard/projects/${halfProject.id}`);
    const buttons = await page.$$eval("main header button, main button", (list) => list.map((b) => b.textContent.trim()).filter((t) => /^(Continue|Re-run|Run)$/.test(t)));
    eq("the page offers to continue, and to run again", [...new Set(buttons)], ["Continue", "Re-run"]);
    const note = await page.$eval('[data-testid="continue-note"]', (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
    eq(
      "  and says what each of the two does, and what to do about a limit",
      note,
      "1 of 3 tasks is done. Continue does the 2 that are left and keeps what is done; Re-run plans anew and does everything again. A task that stopped at a limit of its model can be continued when the limit is over, or after its agent was given another model.",
    );
    const failedSays = await page.$$eval("main p", (list) => list.map((el) => el.textContent.trim()).find((t) => t.startsWith("Provider responded 429")) ?? null);
    check("  the task that failed says what its provider said", /^Provider responded 429: .*You exceeded your current quota, please check your plan and billing details\./.test(failedSays ?? ""), failedSays);
    await snap("project-continue");

    // Its model says "too many requests" the next five times: the task waits, in sight, and is done.
    await fetch(`${MOCK}/__force?model=lim-f&status=429&times=5`);
    await page.click('[data-testid="continue-run"]');
    const waitsCard = await page.waitForSelector('[data-testid="task-waits-limit"]', { timeout: 15_000 }).catch(() => null);
    const waitsSays = waitsCard ? await waitsCard.evaluate((el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => null) : null;
    check(
      "continued, the task whose model is limited waits, and its card says so",
      /^Its model says "not now" \(limited, or busy\)\. Asking it again in \d+ seconds?\. Cancel ends the wait; Continue takes the run up again later\.$/.test(waitsSays ?? ""),
      waitsSays,
    );
    await snap("project-waits-limit");
    check("  the task that was done is still done while the others are worked on", (await tasksNow())[0]?.status === "succeeded" && (await has("Cancel")), (await tasksNow()).map((t) => t.status));
    const result = await waitText("Final deliverable", 60_000);
    const after = await tasksNow();
    eq("  the limit over, the run ends with every task done, without a reload", [result, after.map((t) => t.status)], [true, ["succeeded", "succeeded", "succeeded"]]);
    eq("  the task that was done before was not done again", [after[0]?.id, after[0]?.artifact], [before[0]?.id, before[0]?.artifact]);
    check("  nothing is left to continue: the page offers to run again only", (await page.$('[data-testid="continue-run"]')) === null && (await page.$('[data-testid="continue-note"]')) === null && (await clickableText(/^\s*Re-run\s*$/)), null);
    check("  the list of runs says which one continued the one before it", await waitText("continued the run before it", 10_000), null);
    await snap("project-continued");
  } else {
    check("the project that stopped half way exists (run the full checks first)", false);
  }

  // ─── Stand-ins ─────────────────────────────────────────────────────────────
  begin("Browser: a project that goes on with another model");
  // Left by the checks before, set to do what the installation does: none stands in.
  const ownOnly = projects.find((p) => p.title === "Its own models only");
  if (ownOnly) {
    const asSet = async () => (await api(`/api/projects/${ownOnly.id}`)).data?.project?.standIns;
    const settled = async (want) => {
      for (let i = 0; i < 40 && (await asSet()) !== want; i++) await sleep(250);
      return asSet();
    };
    await open(`/dashboard/projects/${ownOnly.id}`);
    const toggle = '[data-testid="stand-ins"] [role="switch"]';
    const shown = () => page.$eval(toggle, (el) => el.getAttribute("aria-checked")).catch(() => null);
    eq("the project page has the switch, as the project is set", [await shown(), await asSet(), await has("Go on with another model")], ["false", false, true]);
    await page.click(toggle);
    eq("switched on, the project is saved so", [await settled(true), await shown()], [true, "true"]);
    await open(`/dashboard/projects/${ownOnly.id}`);
    eq("  and a page opened later shows it on", await shown(), "true");
    await page.click(toggle);
    eq("  switched off again, it is as it was", [await settled(false), await shown()], [false, "false"]);
    await snap("project-stand-ins");
  } else {
    check("the project of the stand-in checks exists (run the full checks first)", false);
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

  begin("Browser: skills");
  await open("/dashboard/skills");
  check("the navigation has Skills", (await page.$('a[href="/dashboard/skills"]')) !== null);
  const skillInput = await page.$("#skill-files");
  // "a..." so that it is the first of the list, whatever the other checks left there.
  const skillUpload = join(tmpdir(), `browser-skill-${Date.now()}.md`);
  writeFileSync(skillUpload, "---\nname: a-browser-skill\ndescription: A skill uploaded from the browser.\n---\n\n# A browser skill\n\nSay hello first.\n");
  await skillInput.uploadFile(skillUpload);
  check("a SKILL.md can be uploaded", await waitText('"a-browser-skill" added'), null);
  check("  and is listed with its description", await has("A skill uploaded from the browser."), null);
  await clickText(/^\s*Read\s*$/);
  check("its instructions can be read on the page", await waitText("Say hello first."), null);
  await skillInput.uploadFile(skillUpload);
  check("the same skill a second time is refused, with what to do", await waitText(/There is a skill named "a-browser-skill" already/), null);
  await clickText(/Write a skill/);
  await fill("#skill-name", "A typed skill");
  await fill("#skill-description", "Written on the page.");
  await fill("#skill-instructions", "One rule: be brief.");
  await clickText("Add skill", { tag: 'button[type="submit"]' });
  check("a skill can be written on the page", await waitText("One rule: be brief."), null);
  await snap("skills");
  await open("/dashboard/agents");
  await clickText(/Add agent/);
  check("the agent form offers the skills", await waitText("a-browser-skill"), null);
  await snap("agent-skills");

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
  for (const path of ["/dashboard/studio", "/dashboard/knowledge", "/dashboard/skills", "/dashboard/agents", "/dashboard/settings", "/dashboard/workflows", "/dashboard/servers", "/dashboard/browser", detachProject ? `/dashboard/projects/${detachProject.id}` : "/dashboard/projects"]) {
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
    "/dashboard/memory",
    "/dashboard/studio",
    "/dashboard/knowledge",
    "/dashboard/skills",
    "/dashboard/providers",
    "/dashboard/models",
    "/dashboard/servers",
    "/dashboard/browser",
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

  // ─── Accounts ──────────────────────────────────────────────────────────
  begin("Browser: accounts");
  check("the one who signed in first is shown as the owner", await page.$eval("header", (h) => h.innerText.includes("Owner")), null);
  check("an owner has a way to make an account", await clickText("New account", { tag: "button" }), null);
  await fill("#new-username", "browser.user");
  await fill("#new-email", "Browser.User@example.com");
  await fill("#new-password", "a-password-from-the-browser");
  await page.select("#new-role", "admin");
  await snap("account-form");
  await page.click("#create-account");
  check("an account made on the page is said and listed", await waitText('The account "browser.user" was made'), null);
  const accountRow = 'tr[data-user="browser.user"]';
  await page.waitForSelector(accountRow);
  eq("  with the role it was given, and its email in small letters", [await page.$eval(`${accountRow} select`, (s) => s.value), await page.$eval(accountRow, (r) => r.innerText.includes("browser.user@example.com"))], ["admin", true]);
  await page.select(`${accountRow} select`, "user");
  check("its role is changed in the list", await waitText('"browser.user" is user now'), null);
  // The tokens of the account (v1.8): shown in the list, and changed there by an owner.
  const tokensCell = `${accountRow} td[data-tokens="browser.user"]`;
  const cellText = async () => (await page.$eval(tokensCell, (c) => c.innerText)).replace(/\s+/gu, " ").trim();
  eq("the account is listed with its tokens: none used, of ten million", await cellText(), "0 of 10,000,000 10,000,000 left · Change");
  check("  an owner is listed without a limit", await page.$eval('td[data-tokens="admin"]', (c) => c.innerText.includes("No limit") && !c.innerText.includes("Change")), null);
  await clickText("Change", { within: tokensCell, tag: "button" });
  await fill(`${tokensCell} input`, "2.500.000");
  check("a limit is typed with any thousands separator, and the page says what is left after it", await waitText("0 used: 2,500,000 left after this."), null);
  await snap("account-tokens");
  await clickText("Save", { within: tokensCell, tag: "button" });
  check("the limit is changed, and the page says so", await waitText('"browser.user" may use 2,500,000 tokens in all now: 2,500,000 are left.'), null);
  eq("  the list shows it", await cellText(), "0 of 2,500,000 2,500,000 left · Change");
  await clickText("Change", { within: tokensCell, tag: "button" });
  await fill(`${tokensCell} input`, "a lot");
  check("what is no number of tokens cannot be saved", (await waitText("A whole number of tokens.")) && (await page.$eval(`${tokensCell} button[type=submit]`, (b) => b.disabled)), null);
  await clickText("Cancel", { within: tokensCell, tag: "button" });
  // The list has one column more than it had: at this width it is still all there.
  const widths = await page.$eval(`${accountRow}`, (row) => {
    const box = row.closest("table").parentElement;
    return [box.scrollWidth, box.clientWidth];
  });
  check("the whole list is on the page: nothing of it has to be scrolled to", widths[0] <= widths[1], widths);
  await clickText("Manage", { within: accountRow, tag: "button" });
  const manage = 'tr[data-manage="browser.user"]';
  await page.waitForSelector(manage);
  await fill(`${manage} input[id^="username-"]`, "browser.renamed");
  await clickText("Save the name and the email", { within: manage, tag: "button" });
  check("its name is changed", await waitText("The username and the email were saved"), null);
  const renamed = 'tr[data-manage="browser.renamed"]';
  await page.waitForSelector(renamed);
  await fill(`${renamed} input[id^="password-"]`, "another-password-from-the-browser");
  await snap("account-manage");
  await clickText("Set the password", { within: renamed, tag: "button" });
  check("its password is set, and the page says that it was signed out", await waitText('"browser.renamed" has a new password and was signed out everywhere'), null);
  const signIn = (password) =>
    fetch(`${APP}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: "browser.renamed", password }) }).then((res) => res.status);
  eq("  the new password signs in under the new name, the first one no more", [await signIn("another-password-from-the-browser"), await signIn("a-password-from-the-browser")], [200, 401]);
  await clickText("Delete the account", { within: renamed, tag: "button" });
  await clickText("Delete", { within: renamed, tag: "button" });
  check("the account is deleted after being asked once more", (await waitText('The account "browser.renamed" was deleted')) && !(await page.$('tr[data-user="browser.renamed"]')), null);
  await open("/dashboard/settings");
  check("Settings shows an owner what it used, and that it has no limit", await page.$eval("#token-balance", (d) => /Used\s+[\d,]+\s+Limit\s+No limit/u.test(d.innerText) && !d.innerText.includes("Left")), await page.$eval("#token-balance", (d) => d.innerText).catch(() => null));
  await snap("settings-tokens");
  check("Settings has the forms for one's own username, email and password", Boolean(await page.$("#account-username")) && Boolean(await page.$("#password-new")) && (await page.$eval("#account-save", (b) => b.disabled)), null);
  await fill("#account-email", "admin+changed@example.com");
  await fill("#account-current", "not-the-password");
  await page.click("#account-save");
  check("  a change without the right password is refused, and said", await waitText("Password is incorrect"), null);
  await snap("settings-account");

  // ─── What a user is shown ─────────────────────────────────────────────────
  begin("Browser: what a user is shown");
  const VIEWER = { name: "browser.viewer", password: "a-viewer-password-from-the-browser" };
  /** Names of this installation's setup: none of them is for a user. */
  const SETUP_NAMES = ["Mock OpenAI-style", "Mock OpenRouter", "Mock xAI", "Mock Image", "chat-mini", "img-ok", "vid-ok", "tts-1", "text-embedding-3-small"];
  /**
   * What a page says of the setup: the names it holds, and the words for it.
   * Everything the page holds is read, shown or not, except what is written
   * as code: the API's own names (`model`, `/api/v1/models`) are said to all.
   */
  const namedOnPage = async () => {
    const shown = await page.evaluate(() => {
      const body = document.body.cloneNode(true);
      for (const el of body.querySelectorAll("code, pre, script, style")) el.remove();
      const fields = [...body.querySelectorAll("[placeholder], [title], [aria-label]")].map((el) => `${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""}`);
      return `${body.textContent ?? ""} ${fields.join(" ")}`;
    });
    const words = (shown.match(/\b(?:providers?|models?|gateway|upstream|adapters?)\b/gi) ?? []).map((word) => word.toLowerCase());
    return [...new Set([...SETUP_NAMES.filter((name) => shown.includes(name)), ...words])];
  };
  const signInAs = async (name, password) => {
    await api("/api/auth/logout", { method: "POST" });
    await open("/login");
    await fill("#identifier", name);
    await fill("#password", password);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), page.click('button[type="submit"]')]);
  };
  const viewerMade = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: VIEWER.name, email: "viewer@example.com", password: VIEWER.password }) });
  await open("/dashboard/models");
  const usersCard = async (kind) => page.$eval(`#users-models li[data-users-kind="${kind}"]`, (li) => li.innerText.trim()).catch(() => "");
  eq("the Models page says which model users work with", await usersCard("chat"), "Chat and projects: chat-mini · Mock OpenAI-style (marked)");
  const forUsersSwitch = 'button[role="switch"][aria-label="For users: chat-notools"]';
  await page.click(forUsersSwitch);
  check("a model is marked for users with a switch, and the page says what follows", await waitText("Chat and projects: chat-mini · Mock OpenAI-style (marked), then 1 more"), await usersCard("chat"));
  await snap("models-for-users");
  await page.waitForFunction((selector) => !document.querySelector(selector)?.disabled, {}, forUsersSwitch);
  await page.click(forUsersSwitch);
  await page.waitForFunction(() => !document.querySelector('#users-models li[data-users-kind="chat"]')?.innerText.includes("then 1 more"), { timeout: 10_000 }).catch(() => undefined);
  eq("  the mark is taken away again", await usersCard("chat"), "Chat and projects: chat-mini · Mock OpenAI-style (marked)");

  await signInAs(VIEWER.name, VIEWER.password);
  check("a user signs in", viewerMade.status === 201 && page.url().endsWith("/dashboard"), [viewerMade.status, page.url()]);
  const menu = await page.$$eval("nav a[href^='/dashboard']", (links) => [...new Set(links.map((a) => a.getAttribute("href")))]);
  check(
    "the menu of a user has no Providers, Models, Servers, Browser, Skills, Users, Audit and Observability",
    ["/dashboard/providers", "/dashboard/models", "/dashboard/servers", "/dashboard/browser", "/dashboard/skills", "/dashboard/users", "/dashboard/audit", "/dashboard/observability"].every((href) => !menu.includes(href)) &&
      ["/dashboard/projects", "/dashboard/chat", "/dashboard/memory", "/dashboard/studio", "/dashboard/knowledge", "/dashboard/usage", "/dashboard/settings"].every((href) => menu.includes(href)),
    menu,
  );
  check("the overview of a user is about their own work", (await page.$("#own-overview")) !== null && (await namedOnPage()).length === 0, await namedOnPage());
  await snap("user-overview");
  await open("/dashboard/models");
  check("the Models page sends a user back to the overview", page.url().endsWith("/dashboard"), page.url());
  await open("/dashboard/servers");
  check("  and so does the Servers page", page.url().endsWith("/dashboard"), page.url());
  await open("/dashboard/browser");
  check("  and the Browser page", page.url().endsWith("/dashboard"), page.url());
  // A page of the browser that waits for a person is opened by whose work it is, whatever the role: one that is not there says so.
  await open("/dashboard/browser/live/00000000-0000-4000-8000-000000000000");
  check("  a page of the browser that waits for nobody says so, and leads a user back to Chat, not to the Browser page", (await has("This page does not wait any more")) && (await clickableText(/Back to Chat/)) && !(await clickableText(/Browser page/)), (await text()).slice(0, 200));
  await open("/dashboard/memory");
  check(
    "the Memory page of a user says what the assistant can be handed, and what it remembers",
    (await has("Access you handed over")) && (await has("Nothing handed over yet")) && (await has("What the assistant remembers")) && (await namedOnPage()).length === 0,
    (await text()).slice(0, 300),
  );

  await open("/dashboard/chat");
  check("Chat has no model to choose", (await page.$("main select")) === null && (await page.$("textarea[placeholder^='Message']")) !== null, null);
  await page.type("textarea[placeholder^='Message']", "Hello there");
  await clickText(/^\s*Send\s*$/);
  check("  and answers all the same", await waitText('OUTPUT of "?"'), (await text()).slice(0, 300));
  eq("  the page names no model and no provider", await namedOnPage(), []);
  await snap("user-chat");

  await open("/dashboard/studio");
  await page.waitForSelector("#st-prompt");
  const studioWords = (await text()).toLowerCase();
  const studioSaid = ["provider", "gateway", "model", "extra parameters", "estimated cost"].filter((word) => studioWords.includes(word));
  check("Creative Studio has no model to choose, no price and no extra parameters", (await page.$("#st-model")) === null && (await page.$("#st-extra")) === null && studioSaid.length === 0, studioSaid);
  await clickText(/advanced options/);
  check("  its advanced options are the exact size, and no more", (await page.$("#st-size")) !== null && (await page.$("#st-extra")) === null, null);
  await fill("#st-prompt", "A lighthouse made by a user");
  await clickText(/^\s*Generate\s*$/);
  check("  an image is made all the same", await page.waitForSelector('main img[src*="/api/media/"]', { timeout: 30_000 }).then(() => true, () => false), null);
  eq("  the library names no model and no provider", await namedOnPage(), []);
  await snap("user-studio");
  await clickText("Voice", { tag: "[role=tab]" });
  await page.waitForSelector("#st-speech");
  const voiceWords = (await text()).toLowerCase();
  check("  a voice-over has no model to choose either", (await page.$("#st-model")) === null && !["provider", "gateway", "model"].some((word) => voiceWords.includes(word)), voiceWords.slice(0, 300));
  await clickText("Video", { tag: "[role=tab]" });
  await page.waitForSelector("#st-duration");
  const videoWords = (await text()).toLowerCase();
  check("  nor has a video", (await page.$("#st-model")) === null && !["provider", "gateway", "model"].some((word) => videoWords.includes(word)), videoWords.slice(0, 300));

  await open("/dashboard/projects");
  if (!(await page.$("#p-title"))) await clickText(/New project/);
  await page.waitForSelector("#p-title");
  check("a new project has no model to choose, and no server", (await page.$("#p-mgr")) === null && (await page.$("#p-wf")) !== null && (await page.$("#p-servers")) === null, null);
  const plainFlow = await page.$$eval("#p-wf option", (options) => options.find((o) => o.textContent.includes("Seen by users"))?.value);
  await fill("#p-title", "A user's project");
  await fill("#p-goal", "Two lines about lamps.");
  if (plainFlow) await page.select("#p-wf", plainFlow);
  eq("  its form names nothing of the setup, with a workflow chosen", await namedOnPage(), []);
  await snap("user-project-form");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), clickText(/Create project/)]);
  check("  it is made", /\/dashboard\/projects\/[0-9a-f-]{36}$/.test(page.url()) && Boolean(plainFlow), [page.url(), plainFlow]);
  await clickText(/^\s*Run\s*$/);
  check("  it runs to its end", await waitText("Final deliverable", 60_000), (await text()).slice(0, 300));
  // The run is followed live: what the account has left is what the run's events said, not what the page was opened with.
  const mine = await page.evaluate(async () => (await (await fetch("/api/account/me")).json()).user);
  const leftNow = `${new Intl.NumberFormat("en-US").format(mine?.tokensLeft ?? -1)} of your tokens left`;
  check("  the page says what the tasks used, and how many of the account's tokens are left now", (await waitText(leftNow, 5_000)) && /· [1-9][\d,]* tokens used by the tasks · /.test(await text()) && mine?.tokensLeft < mine?.tokenLimit, [leftNow, await page.$eval("#project-tokens", (el) => el.textContent).catch(() => null)]);
  eq("  the page of the project names no model and no provider", await namedOnPage(), []);
  check("  nor what its steps told the agents", !(await has("SECRET-")), null);
  await snap("user-project");

  await open("/dashboard/agents");
  check("Agents & Teams shows a user who the agents are, without a way to change them", (await has("Vis Writer")) && !(await has("SECRET-")) && !(await clickText("Edit")) && (await namedOnPage()).length === 0, await namedOnPage());
  await snap("user-agents");
  await open("/dashboard/workflows");
  check("Workflows shows the steps by title", (await has("Seen by users")) && (await has("Write")) && !(await has("SECRET-")) && !(await has("New workflow")) && (await namedOnPage()).length === 0, await namedOnPage());
  await open("/dashboard/knowledge");
  await clickText(/New collection/);
  await page.waitForSelector("#k-model");
  eq("Knowledge asks a user whether to search by meaning as well, not with what", await page.$$eval("#k-model option", (options) => options.map((o) => [o.value, o.textContent])), [["", "Words only"], ["auto", "By meaning as well"]]);
  await page.select("#k-model", "auto");
  eq("  and its page names nothing of the setup", await namedOnPage(), []);
  await snap("user-knowledge");
  await open("/dashboard/usage");
  // The number under "Tokens (all time)": more than nothing. (A digit followed by a space is not it: the version of a candidate at the foot of the menu has one, "rc.5 · rc".)
  const usageText = await text();
  check("Usage counts a user's tokens, without providers, models and costs", /tokens \(all time\)\s+[1-9][\d.,]*/i.test(usageText) && /requests \(all time\)\s+[1-9]/i.test(usageText) && !(await has("Cost")) && (await namedOnPage()).length === 0, [usageText.replace(/\s+/g, " ").slice(0, 300), await namedOnPage()]);
  await snap("user-usage");
  await open("/dashboard/settings");
  await clickText(/New key/);
  await page.waitForSelector("#ak-rate").catch(() => undefined);
  check("an API key of a user is limited to no model and to no cost", (await page.$("#ak-rate")) !== null && (await page.$("#ak-cost")) === null && !(await has("Only some models")), null);
  eq("  Settings names nothing of the setup outside the API's own words", await namedOnPage(), []);
  await fill("#ak-name", "A user's key");
  await clickText("Create key", { tag: 'button[type="submit"]' });
  await page.waitForSelector('[data-testid="secret-value"]', { timeout: 10_000 }).catch(() => undefined);
  const userKey = await page.$eval('[data-testid="secret-value"]', (e) => e.textContent.trim()).catch(() => "");
  check("  the key is made, and its example sends auto as the model", /^xn_/.test(userKey) && (await page.$$eval("pre", (blocks) => blocks.map((b) => b.textContent).join("\n"))).includes('"model": "auto"'), userKey.slice(0, 6));
  const userModels = await page.evaluate(async (key) => {
    const res = await fetch("/api/v1/models", { headers: { authorization: `Bearer ${key}` }, credentials: "omit" });
    return [res.status, ((await res.json()).data ?? []).map((m) => m.id)];
  }, userKey);
  eq("  with the key, the list of models holds auto and no more", userModels, [200, ["auto"]]);
  eq("  the page still names nothing of the setup", await namedOnPage(), []);
  await snap("user-settings");
  check("no page of a user holds something wider than the screen", (await sideways()) <= 0, await sideways());

  await signInAs("admin", "correct-horse-battery");
  check("the owner signs in again", page.url().endsWith("/dashboard") && (await page.$('a[href="/dashboard/models"]')) !== null, page.url());
  const viewerId = ((await api("/api/admin/users")).data?.users ?? []).find((u) => u.username === VIEWER.name)?.id;
  eq("the account of these checks is deleted", (await api(`/api/admin/users/${viewerId}`, { method: "DELETE" })).status, 200);


  // ─── Servers over SSH ─────────────────────────────────────────────────────
  // The machine is the mock SSH server of these checks; the checks before
  // left one registered ("vps-1"), an agent that has the tool, and projects.
  begin("Browser: servers");
  const SSH_CONTROL = process.env.E2E_SSH_CONTROL_URL ?? "http://127.0.0.1:4013";
  const SSH_PORT = process.env.E2E_SSH_PORT ?? "4012";
  const machine = async (path = "/__state") => (await fetch(`${SSH_CONTROL}${path}`)).json();
  const card = (name) => `[data-server="${name}"]`;
  const inCard = (name) => page.$eval(card(name), (el) => el.closest("section")?.innerText ?? "").catch(() => "");
  const clickIn = (name, label) =>
    page.evaluate(
      (selector, wanted) => {
        const root = document.querySelector(selector)?.closest("section");
        const button = [...(root?.querySelectorAll("button") ?? [])].find((b) => (b.innerText.trim() === wanted || b.getAttribute("aria-label") === wanted) && !b.disabled);
        button?.scrollIntoView({ block: "center" });
        button?.click();
        return Boolean(button);
      },
      card(name),
      label,
    );
  const logRows = () => page.$$eval('[data-testid="server-log"] li', (rows) => rows.map((li) => li.innerText.replace(/\s+/g, " ")));

  check("the owner's menu has Servers", (await page.$('a[href="/dashboard/servers"]')) !== null, null);
  await machine("/__reset");
  await open("/dashboard/servers");
  const before = await machine();
  const vpsText = await inCard("vps-1");
  check("the page shows the machine that is registered: where it is, how it is signed in to, and its host key", vpsText.includes(`root@127.0.0.1:${SSH_PORT}`) && vpsText.includes("signs in with a password") && vpsText.includes(before.fingerprint) && vpsText.includes("Owners only"), vpsText.slice(0, 300));
  check("  and nothing that signs in", !(await text()).includes(before.password), null);
  check("  it says how agents work on a server: one connection, kept open until the run has ended", (await has("one connection")) && (await has("until the run has ended")) && (await has("any command the registered account can")), null);
  check("  the log lists what the runs before did, with the project, the task and the agent", (await logRows()).some((row) => row.includes("echo reached") && row.includes("Ops, plain") && row.includes("by Operator") && row.includes("for admin")), (await logRows()).slice(0, 3));
  await snap("servers");

  await clickText(/New server/);
  await page.waitForSelector("#sv-name");
  const registerDisabled = () => page.$eval('[data-testid="server-form"] button[type="submit"]', (b) => b.disabled);
  await fill("#sv-name", "browser-box");
  await fill("#sv-host", "127.0.0.1");
  await fill("#sv-port", SSH_PORT);
  await fill("#sv-user", "root");
  await fill("#sv-password", before.password);
  await fill("#sv-notes", "The mock of the checks.");
  check("a machine cannot be registered before its host key was read", (await registerDisabled()) === true && (await page.$('[data-testid="host-key"]')) === null, null);
  await clickText(/Read host key/);
  await page.waitForSelector('[data-testid="host-key"]', { timeout: 20_000 }).catch(() => undefined);
  const shownKey = await page.$eval('[data-testid="host-key"]', (el) => el.innerText).catch(() => "");
  check("the key the machine shows is put on the page, with how to compare it", shownKey.includes(`ssh-ed25519 ${before.fingerprint}`) && shownKey.includes("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"), shownKey);
  eq("  reading it signed in to nothing", [(await machine()).signIns, (await machine()).refused], [0, 0]);
  await snap("servers-host-key");
  await fill("#sv-port", "1");
  check("  another port: the key that was read does not count for it", (await registerDisabled()) === true && (await page.$('[data-testid="host-key"]')) === null, null);
  await fill("#sv-port", SSH_PORT);
  await clickText(/Read host key/);
  await page.waitForSelector('[data-testid="host-key"]', { timeout: 20_000 }).catch(() => undefined);
  await clickText(/Register server/);
  check("registering signs in once and says what the one command printed", await waitText(/"browser-box" is registered: the app signed in and ran one command \(\S+ \S+ \S+\)\./), (await text()).slice(0, 400));
  const boxText = await inCard("browser-box");
  check("  the machine is in the list, switched on, for owners only, with the notes", boxText.includes("on") && boxText.includes("Owners only") && boxText.includes("The mock of the checks.") && boxText.includes("no project names it"), boxText.slice(0, 300));

  await clickIn("browser-box", "Check");
  await page.waitForSelector('[data-testid="check-result"]', { timeout: 20_000 }).catch(() => undefined);
  check("Check signs in and runs one command", /The app signed in and ran one command in [\d.]+ s: \S+ \S+ \S+/.test(await inCard("browser-box")), (await inCard("browser-box")).slice(-200));
  await page.click(`${card("browser-box")} button[role="switch"]`);
  check("the switch takes a machine out of use, and says what follows", await waitText('"browser-box" is switched off: no project works on it until it is on again.'), null);
  check("  the list says so", (await inCard("browser-box")).includes("switched off"), null);
  await page.click(`${card("browser-box")} button[role="switch"]`);
  check("  and back", await waitText('"browser-box" is switched on.'), null);

  await page.select('[data-testid="server-log"] select', await page.$$eval('[data-testid="server-log"] select option', (options) => options.find((o) => o.textContent === "browser-box")?.value ?? ""));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="server-log"] li')].every((li) => li.innerText.includes("browser-box")) && document.querySelectorAll('[data-testid="server-log"] li').length >= 2, { timeout: 10_000 }).catch(() => undefined);
  const boxLog = await logRows();
  check("the log of one machine has its registration and its check", boxLog.length === 2 && boxLog[1].includes("Registered: signed in and ran one command") && boxLog[0].includes("Check: signed in and ran one command") && boxLog.every((row) => row.includes("check passed")), boxLog);

  // The machine is set up again: it shows another key.
  const signedInBefore = (await machine()).signIns;
  const rekeyed = await machine("/__rekey");
  await clickIn("browser-box", "Check");
  check("a machine that shows another host key: the check says so, and that nothing was sent", await waitText(/The machine showed another host key .* Nothing was sent to it\./), (await inCard("browser-box")).slice(-300));
  check("  with the key it shows now, to compare", (await inCard("browser-box")).includes(`It showed: ${rekeyed.fingerprint}`), null);
  eq("  nothing was signed in to, and nothing was tried", [(await machine()).signIns - signedInBefore, (await machine()).refused], [0, 0]);
  await snap("servers-other-key");
  await clickIn("browser-box", "Accept this key");
  check("accepting it signs in to the machine that shows it", await waitText('The new host key of "browser-box" is accepted: the app signed in to the machine that shows it.'), null);
  check("  the list has the new fingerprint", (await inCard("browser-box")).includes(rekeyed.fingerprint), null);
  const vpsId = ((await api("/api/servers")).data?.servers ?? []).find((s) => s.name === "vps-1")?.id;
  eq("  (the other machine is the same mock: its new key is accepted too)", (await api(`/api/servers/${vpsId}`, { method: "PATCH", body: JSON.stringify({ hostKey: rekeyed.hostKey }) })).status, 200);

  // A project that works on it, from the form to the log.
  await open("/dashboard/projects");
  if (!(await page.$("#p-title"))) await clickText(/New project/);
  await page.waitForSelector("#p-title");
  const choices = await page.$$eval("#p-servers li", (items) => items.map((li) => li.innerText.replace(/\s+/g, " ")));
  check("a new project of the owner can name servers", choices.length === 2 && choices[0].startsWith("browser-box") && choices[1].startsWith("vps-1") && choices[0].includes(`root@127.0.0.1:${SSH_PORT}`), choices);
  check("  and says what naming one means", (await page.$eval("#p-servers", (el) => el.innerText)).includes("can run any command there"), null);
  const serverFlow = await page.$$eval("#p-wf option", (options) => options.find((o) => o.textContent === "Server work, plain")?.value);
  await fill("#p-title", "Browser ops");
  await fill("#p-goal", "Say that the machine was reached.");
  if (serverFlow) await page.select("#p-wf", serverFlow);
  await page.click("#p-server-browser-box");
  await snap("project-form-servers");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), clickText(/Create project/)]);
  check("  it is made", /\/dashboard\/projects\/[0-9a-f-]{36}$/.test(page.url()) && Boolean(serverFlow), [page.url(), serverFlow]);
  const ticked = await page.$$eval("#project-servers input[type=checkbox]", (boxes) => boxes.map((b) => [b.id, b.checked]));
  eq("  its page shows which servers it works on", ticked, [["ps-server-browser-box", true], ["ps-server-vps-1", false]]);
  eq("  and which of its agents can work there", await page.$eval('[data-testid="server-operators"]', (el) => el.innerText.replace(/\s+/g, " ").trim()).catch(() => "not shown"), "Agents that can work there: Operator.");
  await machine("/__reset");
  await clickText(/^\s*Run\s*$/);
  check("  it runs to its end", await waitText("Final deliverable", 60_000), (await text()).slice(0, 300));
  const reached = await machine();
  eq("  the agent's command reached the machine, over one connection that is closed now", [reached.commands, reached.connections, reached.open], [["echo reached"], 1, 0]);
  await snap("project-servers");
  await page.click("#ps-server-vps-1");
  await clickText(/Save servers/);
  await page.waitForFunction(() => ![...document.querySelectorAll("#project-servers button")].some((b) => b.innerText.trim() === "Save servers"), { timeout: 10_000 }).catch(() => undefined);
  const browserOps = ((await api("/api/projects")).data?.projects ?? []).find((p) => p.title === "Browser ops");
  eq("  its servers are changed on its page", browserOps?.servers?.map((s) => s.name), ["browser-box", "vps-1"]);

  await open("/dashboard/servers");
  const opsRows = (await logRows()).filter((row) => row.includes("Browser ops"));
  check("the Servers page has what that run did: connected, the command, closed", opsRows.length === 3 && /connection .*Browser ops for admin Closed · The run has ended\./.test(opsRows[0]) && opsRows[1].includes("exit 0") && opsRows[1].includes("Tool: ssh plain by Operator for admin echo reached") && opsRows[2].includes("Connected · Signed in as root."), opsRows);
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="server-log"] li')].find((li) => li.innerText.includes("echo reached") && li.innerText.includes("Browser ops"))?.querySelector("button")?.click());
  check("  with what the command printed", await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="server-log"] pre')].some((pre) => pre.innerText.trim() === "reached"), { timeout: 5000 }).then(() => true, () => false), null);
  check("  the machine says that a project names it", (await inCard("browser-box")).includes("1 project names it"), (await inCard("browser-box")).slice(0, 300));
  await snap("servers-log");

  await open("/dashboard/agents");
  await clickText(/Add agent/);
  // The headings of the tool groups are shown in capitals.
  await waitText(/SERVERS OVER SSH|Servers over SSH/);
  check("the agent form offers the tool, and says where an agent is handed it", (await has("Work on servers")) && (await has("Only in a project that names a server")), (await text()).slice(0, 300));
  await snap("agent-form-servers");

  await open("/dashboard/servers");
  await clickIn("browser-box", "Remove browser-box");
  check("the owner removes a machine", await waitText('"browser-box" was removed.'), null);
  check("  it is gone from the list", (await page.$(card("browser-box"))) === null && (await page.$(card("vps-1"))) !== null, null);
  await page.select('[data-testid="server-log"] select', "removed");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="server-log"] li').length > 0 && [...document.querySelectorAll('[data-testid="server-log"] li')].every((li) => li.innerText.includes("browser-box")), { timeout: 10_000 }).catch(() => undefined);
  check("  what was done on it stays in the log", (await logRows()).some((row) => row.includes("browser-box") && row.includes("echo reached")), (await logRows()).slice(0, 3));
  eq("  the project that named it has the other machine left", ((await api("/api/projects")).data?.projects ?? []).find((p) => p.title === "Browser ops")?.servers?.map((s) => s.name), ["vps-1"]);
  check("the Servers page holds nothing wider than the screen", (await sideways()) <= 0, await sideways());

  // ─── The browser agents work in ───────────────────────────────────────────
  begin("Browser: the browser agents work in");
  const SITE = process.env.E2E_SITE_URL ?? "http://127.0.0.1:4014";
  const siteState = async (path = "/__state") => (await fetch(`${SITE}${path}`)).json();
  const account = (name) => `[data-account="${name}"]`;
  const inAccount = (name) => page.$eval(account(name), (el) => el.closest("section")?.innerText ?? "").catch(() => "");
  const clickInAccount = (name, label) =>
    page.evaluate(
      (selector, wanted) => {
        const root = document.querySelector(selector)?.closest("section");
        const button = [...(root?.querySelectorAll("button") ?? [])].find((b) => (b.innerText.trim() === wanted || b.getAttribute("aria-label") === wanted) && !b.disabled);
        button?.scrollIntoView({ block: "center" });
        button?.click();
        return Boolean(button);
      },
      account(name),
      label,
    );
  /** Click a point of the page that is shown in the live view, as a person does: on the picture. */
  const clickOnPicture = async (x, y) => {
    const box = await page.$eval('[data-testid="live-screen"]', (img) => {
      img.scrollIntoView({ block: "center" });
      const r = img.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    await page.mouse.click(box.left + (x / 1280) * box.width, box.top + (y / 800) * box.height);
  };
  const waitFor = async (read, done, tries = 40) => {
    let value;
    for (let i = 0; i < tries; i++) {
      value = await read();
      if (done(value)) return value;
      await sleep(250);
    }
    return value;
  };

  if (!process.env.E2E_GATE_URL) {
    await open("/dashboard/browser");
    check("without a browser service the page says what is missing", await has("No browser service is set up on this server"), null);
  } else {
    check("the owner's menu has Browser", (await page.$('a[href="/dashboard/browser"]')) !== null, null);
    await siteState("/__reset");
    await open("/dashboard/browser");
    const service = await page.$eval('[data-testid="browser-service"]', (el) => el.innerText);
    check("the page says how the browser service is: that it answers, what it is, and that pages cannot reach private networks", service.includes("answers") && /Chrom/.test(service) && service.includes("Pages cannot reach private networks") && service.includes("It tells sites what it is"), service);
    check("  and nothing that signs in to it", !(await text()).includes(process.env.E2E_GATE_TOKEN ?? "no-token") && !/token=/.test(await text()), null);
    const shopText = await inAccount("shop");
    check("the accounts that are saved: who signs in where, whose projects may use it, and whether a session is kept", shopText.includes("budi on 127.0.0.1") && shopText.includes(`${SITE}/login`) && shopText.includes("Owners only") && shopText.includes("session kept") && shopText.includes("The example shop."), shopText.slice(0, 300));
    check("  and no password", !(await text()).includes("rahasia-budi-123"), null);
    check("it says what is a person's, and that a session is kept", (await has("is yours to do")) && (await has("The app does not solve one and does not get around one")) && (await has("The session a sign-in left is kept with the account")) && (await has("the app types the password")), null);
    const browserLog = () => page.$$eval('[data-testid="browser-log"] li', (rows) => rows.map((li) => li.innerText.replace(/\s+/g, " ")));
    check("the log lists what the runs before did, with the project, the task and the agent", (await browserLog()).some((row) => row.includes("signed in") && row.includes("by Surfer") && row.includes("for admin")) && (await browserLog()).some((row) => row.includes("a person")), (await browserLog()).slice(0, 4));
    await snap("browser");

    await clickText(/New account/);
    await page.waitForSelector("#ba-name");
    await fill("#ba-name", "browser-shop");
    await fill("#ba-url", `${SITE}/captcha-login`);
    await fill("#ba-user", "sari");
    await fill("#ba-password", "sari-pass-456");
    await fill("#ba-notes", "The mock of the checks.");
    await snap("browser-account-form");
    await clickText(/Save account/);
    check("an owner saves an account", await waitText('"browser-shop" is saved.'), (await text()).slice(0, 300));
    const madeText = await inAccount("browser-shop");
    check("  it is in the list, switched on, for owners only, without a session", madeText.includes("sari on 127.0.0.1") && madeText.includes("on") && madeText.includes("Owners only") && madeText.includes("no session kept") && madeText.includes("The mock of the checks.") && madeText.includes("no project names it"), madeText.slice(0, 300));
    check("  the password is not on the page", !(await text()).includes("sari-pass-456") && (await page.$("#ba-password")) === null, null);

    // The owner signs in by hand: the app fills in the form, the owner ticks the box and sends it.
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => undefined), clickInAccount("browser-shop", "Sign in by hand")]);
    check("Sign in by hand opens the site on a page of its own", /\/dashboard\/browser\/live\/[0-9a-f-]{36}$/.test(page.url()), page.url());
    await page.waitForSelector('[data-testid="live-screen"]', { timeout: 20_000 }).catch(() => undefined);
    check("  the app says what it did and what is left for the owner", await waitText("The app filled in the form. The site asks for a CAPTCHA (reCAPTCHA): do that here, send the form, and keep the session when you are in."), (await text()).slice(0, 500));
    check("  the page is shown as a picture, with where it is", (await page.$('[data-testid="live-screen"]')) !== null && (await waitFor(() => page.$eval('[data-testid="live-url"]', (el) => el.innerText).catch(() => ""), (url) => url.includes("/captcha-login"))).includes(`${SITE}/captcha-login`), null);
    await sleep(1200);
    await snap("browser-live-owner");
    await clickOnPicture(66, 326);
    const ticked = await waitFor(siteState, (s) => s.passed.includes("captcha"));
    eq("a click on the picture is a click on the page: the box of the CAPTCHA is ticked", ticked.passed, ["captcha"]);
    await clickOnPicture(100, 420);
    const signedIn = await waitFor(siteState, (s) => s.signIns.length === 1);
    eq("  and the form is sent: signed in", signedIn.signIns, [{ user: "sari", from: "/captcha-login" }]);
    check("  the picture follows: the page behind the form", (await waitFor(() => page.$eval('[data-testid="live-url"]', (el) => el.innerText).catch(() => ""), (url) => url.endsWith("/account"))).endsWith("/account"), null);
    await clickText(/Keep the session/);
    check("the owner keeps the session", await waitText("The session is kept with the account: the next run is let in without signing in again."), (await text()).slice(0, 300));
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => undefined), clickText(/Back to the Browser page/)]);
    await page.waitForSelector(account("browser-shop"));
    check("  the account says so", (await waitFor(() => inAccount("browser-shop"), (t) => t.includes("session kept") && !t.includes("no session kept"))).includes("1 cookie"), (await inAccount("browser-shop")).slice(0, 300));

    // A project that signs in with it, from the form to a page that waits for a person.
    const surfer = ((await api("/api/agents")).data?.agents ?? []).find((a) => a.name === "Surfer");
    const waitingFlow = (await api("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Browser: waiting", steps: [{ title: "Tool: browser waiting", objective: `BROWSER: ${JSON.stringify({ action: "sign_in", account: "browser-shop" })}\nBROWSER: ${JSON.stringify({ action: "ask_person", reason: "Look whether the note is right." })}`, role: "Surfer" }] }) })).data?.workflow?.id;
    await open("/dashboard/projects");
    if (!(await page.$("#p-title"))) await clickText(/New project/);
    await page.waitForSelector("#p-title");
    const accountChoices = await page.$$eval("#p-accounts li", (items) => items.map((li) => li.innerText.replace(/\s+/g, " ")));
    check("a new project of the owner can name site accounts", accountChoices.some((c) => c.startsWith("browser-shop") && c.includes("sari on 127.0.0.1")) && accountChoices.some((c) => c.startsWith("shop ")), accountChoices);
    check("  and says what naming one means", (await page.$eval("#p-accounts", (el) => el.innerText)).includes("an agent is never shown it"), null);
    await fill("#p-title", "Browser web");
    await fill("#p-goal", "Look at the account.");
    const waitingOption = await page.$$eval("#p-wf option", (options) => options.find((o) => o.textContent === "Browser: waiting")?.value);
    if (waitingOption) await page.select("#p-wf", waitingOption);
    await page.click("#p-account-browser-shop");
    const sameSite = await page.$eval("#p-account-shop", (box) => ({ disabled: box.disabled, says: (box.closest("li")?.innerText ?? "").replace(/\s+/g, " ") }));
    check("  an account of the same site cannot be ticked with it, and says why", sameSite.disabled === true && sameSite.says.includes("The same site as browser-shop: one of them."), sameSite);
    await snap("project-form-accounts");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), clickText(/Create project/)]);
    check("  it is made", /\/dashboard\/projects\/[0-9a-f-]{36}$/.test(page.url()) && Boolean(waitingOption) && Boolean(surfer), [page.url(), waitingOption]);
    const projectUrl = page.url();
    const tickedAccounts = await page.$$eval("#project-accounts input[type=checkbox]", (boxes) => boxes.filter((b) => b.checked).map((b) => b.id));
    eq("  its page shows which accounts it signs in with", tickedAccounts, ["pa-account-browser-shop"]);
    eq("  and which of its agents can", await page.$eval('[data-testid="account-agents"]', (el) => el.innerText.replace(/\s+/g, " ").trim()).catch(() => "not shown"), "Agents that can sign in with them: Surfer.");
    await siteState("/__reset?sessions=keep");
    await clickText(/^\s*Run\s*$/);
    await page.waitForSelector('[data-testid="task-waits"]', { timeout: 60_000 }).catch(() => undefined);
    const waits = await page.$eval('[data-testid="task-waits"]', (el) => el.innerText.replace(/\s+/g, " ")).catch(() => "");
    check("a task that waits for a person says so on the project's page, with where the page is", waits.includes("Waiting for a person on 127.0.0.1: Look whether the note is right.") && waits.includes("Open the page"), waits);
    check("  the agent was let in with the session the owner kept: the site saw no sign-in", (await siteState()).signIns.length === 0 && (await siteState()).pages.some((p) => p.path === "/account" && p.user === "sari"), (await siteState()).signIns);
    await snap("project-waits");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => undefined), clickText(/Open the page/, { tag: "a" })]);
    await page.waitForSelector('[data-testid="live-screen"]', { timeout: 20_000 }).catch(() => undefined);
    const reason = await page.$eval('[data-testid="live-reason"]', (el) => el.innerText.replace(/\s+/g, " ")).catch(() => "");
    check("the page that waits says what for, and for which project, task and agent", reason.includes("Look whether the note is right.") && reason.includes("Browser web") && reason.includes("Tool: browser waiting") && reason.includes("by Surfer"), reason);
    // The person adds a note themselves: a click into the field, then the keyboard.
    await sleep(1200);
    await page.type('[data-testid="live-text"]', "Typed by a person");
    await snap("browser-live-run");
    // The field "New note" is the only field of the page: the Tab key gets there from the top.
    await page.evaluate(() => document.querySelector('[data-testid="live-screen"]')?.parentElement?.focus());
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await sleep(600);
    await clickText(/Type it/);
    await sleep(600);
    await page.evaluate(() => document.querySelector('[data-testid="live-screen"]')?.parentElement?.focus());
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const noted = await waitFor(siteState, (s) => s.notes.length >= 1, 30);
    eq("what the person types is typed on the page", noted.notes, [{ user: "sari", text: "Typed by a person" }]);
    await clickText(/Hand back to the agent/);
    check("the person hands the page back", await waitText("The page is handed back: the agent goes on from where you left it."), (await text()).slice(0, 300));
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => undefined), clickText(/Back to the project/)]);
    await page.waitForFunction((url) => location.href === url, { timeout: 10_000 }, projectUrl).catch(() => undefined);
    check("  and the run goes on to its end", (await waitText("Final deliverable", 60_000)) && page.url() === projectUrl, (await text()).slice(0, 300));
    await snap("project-accounts");

    await open("/dashboard/browser");
    const mine = (await browserLog()).filter((row) => row.includes("Browser web"));
    check("the Browser page has what that run did: let in with the session, and a page a person took over", mine.some((row) => row.includes("signed in") && row.includes("browser-shop")) && mine.some((row) => row.includes("a person") && row.includes("handed back") && row.includes("Look whether the note is right.")), mine);
    check("  and what the owner did by hand", (await browserLog()).some((row) => row.includes("by hand") && row.includes("session kept") && row.includes("browser-shop")), null);
    check("  what the person typed is in none of it", !(await text()).includes("Typed by a person"), null);
    check("  the account says that a project names it", (await inAccount("browser-shop")).includes("1 project names it"), (await inAccount("browser-shop")).slice(0, 300));
    await snap("browser-log");

    await open("/dashboard/agents");
    await clickText(/Add agent/);
    await waitText(/BROWSER|Browser/);
    check("the agent form offers the tool, and says in whose projects an agent is handed it", (await has("Work in a browser")) && (await has("A CAPTCHA or a code is left to a person")) && (await has("Only in the projects of owners and administrators")), null);

    await open("/dashboard/browser");
    await clickInAccount("browser-shop", "Drop session");
    check("the owner drops a session", await waitText('The session of "browser-shop" was dropped.'), null);
    await clickInAccount("browser-shop", "Remove browser-shop");
    check("the owner removes an account", await waitText('"browser-shop" was removed.'), null);
    check("  it is gone from the list, and what was done with it stays in the log", (await page.$(account("browser-shop"))) === null && (await page.$(account("shop"))) !== null && (await browserLog()).some((row) => row.includes("browser-shop")), null);
    check("the Browser page holds nothing wider than the screen", (await sideways()) <= 0, await sideways());
  }

  // ─── Access handed over in a conversation ─────────────────────────────────
  // The machine is the mock SSH server; the assistant is the mock provider,
  // which does what the lines "DO: {…}" of a message say.
  begin("Browser: a server handed over in Chat, and what is remembered");
  {
    const now = await machine();
    const transcript = () => page.$eval('[data-testid="transcript"]', (el) => el.innerText).catch(() => "");
    /** Put a text of several lines into the message field, as pasting does. */
    const write = (value) =>
      page.evaluate((v) => {
        const field = document.querySelector("textarea[placeholder^='Message']");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, v);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    const chooseModel = async () => page.select("main select", await page.$$eval("main select option", (options) => options.find((o) => o.textContent.startsWith("chat-mini"))?.value ?? ""));
    const mine = async () => (await api("/api/memory")).data;
    for (const item of (await mine())?.access ?? []) await api(`/api/access/${item.kind}/${item.id}`, { method: "DELETE" });

    await open("/dashboard/chat");
    check("Chat says that the assistant can be handed a server, a site or a key", (await has("Write how to sign in to a server, a web site or an API")) && (await has("What you tell it is remembered")), (await text()).slice(0, 300));
    await chooseModel();
    await write(`ini vps ku, tolong cek\nIP: 127.0.0.1\nPort: ${SSH_PORT}\nUser: root\nPass: ${now.password}\nDO: {"tool":"run_on_server","args":{"command":"echo from-the-chat-page; id -un"}}`);
    await clickText(/^\s*Send\s*$/);
    check("the assistant works on the server that was written into the message", await waitText("DONE after 1 tool results.", 40_000), (await transcript()).slice(0, 400));
    const said = await transcript();
    check("  the message is shown without its password, with what became of it", !said.includes(now.password) && said.includes('Pass: [password kept by the app as "vps-127-0-0-1"]'), said.slice(0, 300));
    const keptLine = await page.$eval('[data-testid="kept"]', (el) => el.innerText).catch(() => "");
    check("  under it: that the server was tried and kept, and under which name", keptLine.includes(`root@127.0.0.1:${SSH_PORT}`) && keptLine.includes('kept as "vps-127-0-0-1"') && keptLine.includes(now.fingerprint), keptLine);
    await clickText(/with tools/);
    check("  what the assistant did with its tools can be read", (await waitText("echo from-the-chat-page; id -un")) && (await has("from-the-chat-page")), (await transcript()).slice(0, 400));
    check("  no password is anywhere on the page", !(await text()).includes(now.password), null);
    await snap("chat-handover");
    const chatUrl = page.url();
    check("  the address names the conversation", /\/dashboard\/chat\?c=[0-9a-f-]{36}$/.test(chatUrl), chatUrl);
    await page.reload({ waitUntil: "networkidle2" });
    check("  opened again, it is as it was left", (await transcript()).includes("DONE after 1 tool results.") && (await transcript()).includes("kept by the app as") && !(await text()).includes(now.password), (await transcript()).slice(0, 300));
    check("  it is in the list of conversations under its first line", (await page.$$eval('ul[aria-label="Conversations"] li', (rows) => rows.map((li) => li.innerText))).some((row) => row.includes("ini vps ku, tolong cek")), null);

    await clickText(/New conversation/);
    await chooseModel();
    await page.type("textarea[placeholder^='Message']", "Server mana saja yang kamu punya?");
    await clickText(/^\s*Send\s*$/);
    check("a new conversation has the server without being told again", await waitText("servers=vps-127-0-0-1", 30_000), (await transcript()).slice(0, 400));

    // An answer that works for a while: the page is left, and finds the answer when it comes back.
    await clickText(/New conversation/);
    await chooseModel();
    await write('tolong tunggu sebentar\nDO: {"tool":"run_on_server","args":{"command":"sleep 5; echo finished-while-away"}}');
    await clickText(/^\s*Send\s*$/);
    await page.waitForFunction(() => /\?c=[0-9a-f-]{36}$/.test(location.href), { timeout: 15_000 }).catch(() => undefined);
    const awayUrl = page.url();
    await open("/dashboard/memory");
    check("the Memory page lists the server, without what signs in", (await page.$eval('[data-testid="access-list"]', (el) => el.innerText).catch(() => "")).includes("vps-127-0-0-1") && (await has(`root@127.0.0.1:${SSH_PORT}`)) && !(await text()).includes(now.password), (await text()).slice(0, 300));
    await page.type('textarea[aria-label="A note for the assistant"]', "Laporan selalu dalam bahasa Indonesia.");
    await clickText(/Add note/);
    check("  a note can be written by hand", (await waitText("Written by you")) && (await page.$eval('[data-testid="notes-list"]', (el) => el.innerText).catch(() => "")).includes("Laporan selalu dalam bahasa Indonesia."), null);
    await snap("memory");
    await page.goto(awayUrl, { waitUntil: "networkidle2" });
    check("an answer that was left to itself is there when the page comes back", await waitText("finished-while-away", 40_000), (await transcript()).slice(0, 400));
    await page.waitForFunction(() => ![...document.querySelectorAll("main button")].some((b) => b.innerText.trim() === "Stop"), { timeout: 15_000 }).catch(() => undefined);
    check("  and the conversation takes the next message: nothing is being worked on any more", (await clickableText(/^\s*Stop\s*$/)) === false && (await page.$("textarea[placeholder^='Message']")) !== null, null);

    // A project whose goal says how to sign in.
    await open("/dashboard/projects");
    await clickText(/New project/);
    await page.waitForSelector("#p-goal");
    await fill("#p-title", "Cek VPS dari halaman");
    await page.evaluate((v) => {
      const field = document.querySelector("#p-goal");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, v);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }, `Cek disk di VPS 127.0.0.1 port ${SSH_PORT} user root pass ${now.password} lalu laporkan.`);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => undefined), clickText(/Create project/)]);
    const keptNow = await page.$eval('[data-testid="kept-now"]', (el) => el.innerText).catch(() => "");
    check("a project whose goal says how to sign in: the page says what was kept, and the goal holds no password", /\/dashboard\/projects\/[0-9a-f-]{36}$/.test(page.url()) && keptNow.includes('kept again as "vps-127-0-0-1"') && !(await text()).includes(now.password) && (await has("[password kept by the app as")), [page.url(), keptNow]);
    const handed = await page.$eval('[data-testid="handed"]', (el) => el.innerText).catch(() => "");
    check("  and what its runs work with", handed.includes("vps-127-0-0-1"), handed);
    await snap("project-handed");

    await page.setViewport({ width: 390, height: 780 });
    await open("/dashboard/chat");
    const chatWide = await sideways();
    await open("/dashboard/memory");
    check("Chat and Memory hold nothing wider than a phone's screen", chatWide <= 0 && (await sideways()) <= 0, [chatWide, await sideways()]);
    await page.setViewport({ width: 1360, height: 900 });

    await open("/dashboard/memory");
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-testid="access-list"] li')].find((li) => li.innerText.includes("vps-127-0-0-1"));
      [...(row?.querySelectorAll("button") ?? [])].find((b) => b.innerText.includes("Remove"))?.click();
    });
    check("what was handed over is removed on the Memory page", (await waitText("Nothing handed over yet")) && ((await mine())?.access ?? []).length === 0, null);
    for (const note of (await mine())?.notes ?? []) await api(`/api/memory/${note.id}`, { method: "DELETE" });
  }

  // ─── Model checks ─────────────────────────────────────────────────────────
  // Last, since Check all now asks every model of these checks, also the ones made to fail.
  begin("Browser: model checks");
  await open("/dashboard/agents");
  const keeperOpened = await page.evaluate(() => {
    const row = [...document.querySelectorAll("main li, main article, main div")].filter((el) => el.innerText?.includes("Health keeper") && [...el.querySelectorAll("button")].some((b) => b.innerText.trim() === "Edit")).pop();
    const edit = row ? [...row.querySelectorAll("button")].find((b) => b.innerText.trim() === "Edit") : null;
    edit?.click();
    return Boolean(edit);
  });
  await page.waitForSelector("#a-pri").catch(() => undefined);
  const setTo = await page.$eval("#a-pri", (select) => select.selectedOptions[0]?.textContent ?? "").catch(() => "");
  check("an agent that is set to a failing model shows it in its form, with the reason", keeperOpened && /^health-switch · .* \(not offered: failed its last check\)$/.test(setTo), setTo);
  const offered = await page.$$eval("#a-fb option", (options) => options.map((o) => o.textContent));
  check("  the model is not offered for anything else", offered.length > 2 && !offered.some((o) => o.startsWith("health-switch")), offered.length);
  await snap("agent-failing-model");

  await open("/dashboard/models");
  check("the Models page says how the models are checked, and marks the ones left out", (await has("The automatic check is switched off")) && /\d+ models? (is|are) left out now\./.test(await text()) && (await has("left out of the lists")), null);
  await clickText(/Check all now/);
  check("Check all now asks every model, and says what it found", await waitText(/Last check .*: \d+ asked, \d+ answered, \d+ failed\./, 240_000), (await text()).slice(0, 400));
  const found = /Last check .*: (\d+) asked, (\d+) answered, (\d+) failed\./.exec(await text());
  const leftOut = Number(/(\d+) models? (is|are) left out now\./.exec(await text())?.[1] ?? -1);
  const marked = await page.$$eval("main .badge", (badges) => badges.filter((b) => b.innerText.trim() === "left out of the lists").length);
  check("  every model that failed is marked in the list, without a reload", found !== null && Number(found[3]) > 1 && leftOut === marked && marked >= Number(found[3]), { found: found?.slice(1), leftOut, marked });
  await snap("models-checked");
  const counts = await page.$eval('[data-testid="model-counts"]', (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
  check("  the page says how many of the models that are switched on work", /^Of the \d+ that are switched on: [1-9]\d* works?(, \d+ rests?)?(, \d+ (was|were) never asked)?\.$/.test(counts ?? ""), counts);
  check("  and that real work counts as a check", (await has("Real work counts as well")) && (await has("A run then goes on with another model that works")), null);

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
