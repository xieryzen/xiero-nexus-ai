import assert from "node:assert/strict";
import { test } from "node:test";
import { upstreamErrorMessage } from "../src/lib/adapters/gemini-protocol";
import { AppError } from "../src/lib/errors";
import {
  LIMIT_WAIT_DEFAULT_MINUTES,
  LIMIT_WAIT_MAX_MINUTES,
  failureText,
  limitWaitMs,
  limitWaitNote,
  nextLimitWait,
} from "../src/lib/orchestrator/limit-wait";
import { durationMs, limitHint, quotaViolations, waitInText, waitWords } from "../src/lib/provider-limits";
import { WORKING, publicText } from "../src/lib/public-text";
import { MAX_RETRY_WAIT_MS, Patience, fetchWithRetries, retryDelayMs } from "../src/lib/retry";
import { limitOf, upstreamError } from "../src/lib/upstream";

// What Google answers when a quota is used up, as its API sends it (shapes
// from its forum and from the issues of the tools that call it).
const HEAD =
  "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: " +
  "https://aistudio.google.com/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. ";
const METRIC = "generativelanguage.googleapis.com/generate_content_free_tier_requests";

function google(opts: { lines: string[]; retry: string; violations: Record<string, unknown>[]; delay: string }): string {
  return JSON.stringify({
    error: {
      code: 429,
      message: `${HEAD}\n${opts.lines.map((line) => `* Quota exceeded for metric: ${line}`).join("\n")}\nPlease retry in ${opts.retry}.`,
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more about Gemini API quotas", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }] },
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: opts.violations },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: opts.delay },
      ],
    },
  });
}

const PER_DAY = google({
  lines: [`${METRIC}, limit: 20, model: gemini-3.6-flash`],
  retry: "17h18m5.924610153s",
  delay: "62285s",
  violations: [{ quotaMetric: METRIC, quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { location: "global", model: "gemini-3.6-flash" }, quotaValue: "20" }],
});
/** A quota for the day whose answer asks for half a minute, as Google's did for a long time. */
const PER_DAY_SHORT = google({
  lines: [`${METRIC}, limit: 50`],
  retry: "34.074824224s",
  delay: "34s",
  violations: [{ quotaMetric: METRIC, quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { location: "global", model: "gemini-2.5-pro" }, quotaValue: "50" }],
});
const PER_MINUTE = google({
  lines: [`${METRIC}, limit: 5, model: gemini-3.5-flash`],
  retry: "46.130728812s",
  delay: "46s",
  violations: [{ quotaMetric: METRIC, quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaDimensions: { location: "global", model: "gemini-3.5-flash" }, quotaValue: "5" }],
});
/** A model the free tier gives nothing of: three quotas at once, none with its allowance in the details. */
const NO_ALLOWANCE = google({
  lines: [
    "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-2.0-flash",
    `${METRIC}, limit: 0, model: gemini-2.0-flash`,
    `${METRIC}, limit: 0, model: gemini-2.0-flash`,
  ],
  retry: "17.5963543s",
  delay: "17s",
  violations: [
    { quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count", quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier", quotaDimensions: { location: "global", model: "gemini-2.0-flash" } },
    { quotaMetric: METRIC, quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaDimensions: { location: "global", model: "gemini-2.0-flash" } },
    { quotaMetric: METRIC, quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { model: "gemini-2.0-flash", location: "global" } },
  ],
});

// ─── What a provider says about its limit ────────────────────────────────────

test("a length of time, as providers write it", () => {
  assert.equal(durationMs("37.258156337s"), 37_258);
  assert.equal(durationMs("17h18m5.924610153s"), 17 * 3_600_000 + 18 * 60_000 + 5925);
  assert.equal(durationMs("6m0s"), 360_000);
  assert.equal(durationMs("250ms"), 250);
  assert.equal(durationMs("62285s"), 62_285_000);
  assert.equal(durationMs("1 seconds"), 1000);
  assert.equal(durationMs("2 minutes"), 120_000);
  assert.equal(durationMs("1.5 hours"), 5_400_000);
  assert.equal(durationMs(" 20S "), 20_000);
  for (const not of ["", "soon", "42", "3 attempts", "5 months", "1e9s", "-5s", "99999h", "s"]) assert.equal(durationMs(not), null, not);
});

test("the wait a sentence asks for", () => {
  assert.equal(waitInText("Please retry in 37.258156337s."), 37_258);
  assert.equal(waitInText("Rate limit reached for gpt-4o. Please try again in 20s. Visit the page."), 20_000);
  assert.equal(waitInText("Limit 30000, Used 29000. Please try again in 6m0s."), 360_000);
  assert.equal(waitInText("please try again in 349ms"), 349);
  assert.equal(waitInText("Rate limit exceeded. Retry after 1 seconds."), 1000);
  assert.equal(waitInText("Too many requests, retry in 2 minutes"), 120_000);
  assert.equal(waitInText("Please retry in 17h18m5.924610153s."), 62_285_925);
  for (const none of ["Rate limit reached for requests.", "Sign up for free or come back later.", "retry in a while", "try again in 3 attempts", "Please retry in 5 months."]) {
    assert.equal(waitInText(none), null, none);
  }
});

test("Google names the quota: how it is counted, its allowance and the model", () => {
  assert.deepEqual(quotaViolations(PER_DAY), [{ metric: "generate_content_free_tier_requests", window: "day", limit: 20, model: "gemini-3.6-flash" }]);
  assert.deepEqual(quotaViolations(PER_MINUTE), [{ metric: "generate_content_free_tier_requests", window: "minute", limit: 5, model: "gemini-3.5-flash" }]);
  // Without the allowance in the details, it is the one of the message's line for the same quota.
  assert.deepEqual(quotaViolations(NO_ALLOWANCE), [
    { metric: "generate_content_free_tier_input_token_count", window: "minute", limit: 0, model: "gemini-2.0-flash" },
    { metric: "generate_content_free_tier_requests", window: "minute", limit: 0, model: "gemini-2.0-flash" },
    { metric: "generate_content_free_tier_requests", window: "day", limit: 0, model: "gemini-2.0-flash" },
  ]);
  assert.deepEqual(quotaViolations("not JSON"), []);
  assert.deepEqual(quotaViolations(JSON.stringify({ error: { message: "Rate limit reached for requests." } })), []);
  assert.deepEqual(quotaViolations(JSON.stringify([{ error: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "Weird" }] }] } }])), [
    { metric: "", window: null, limit: null, model: null },
  ]);
});

test("a limit for the minute is one to wait for; a quota for the day, a model without allowance and an account without credit are not", () => {
  assert.deepEqual(limitHint(PER_MINUTE), { waitMs: 46_131, lasting: false });
  assert.deepEqual(limitHint(PER_DAY), { waitMs: 62_285_925, lasting: true });
  assert.deepEqual(limitHint(PER_DAY_SHORT), { waitMs: 34_075, lasting: true }, "the quota's id decides, not the half minute the answer asks for");
  assert.deepEqual(limitHint(NO_ALLOWANCE), { waitMs: 17_596, lasting: true });
  // The same words without the details: the allowance of nothing is in the message.
  assert.equal(limitHint(JSON.stringify({ error: { message: "* Quota exceeded for metric: x, limit: 0, model: m\nPlease retry in 12s." } })).lasting, true);
  assert.equal(limitHint(JSON.stringify({ error: { message: "* Quota exceeded for metric: x, limit: 0.5, model: m" } })).lasting, false);
  assert.deepEqual(
    limitHint(JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } })),
    { waitMs: null, lasting: true },
  );
  assert.deepEqual(limitHint(JSON.stringify({ error: { message: "Rate limit reached. Please try again in 7.66s.", type: "tokens", code: "rate_limit_exceeded" } })), { waitMs: 7660, lasting: false });
  // Only the wait of the details, in whole seconds, when the words name none.
  assert.deepEqual(limitHint(JSON.stringify({ error: { message: "Resource has been exhausted.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9s" }] } })), { waitMs: 9000, lasting: false });
  // An answer that says nothing: the limit may be over any moment.
  for (const nothing of [null, undefined, "", "   ", "Too Many Requests", "<html>busy</html>", JSON.stringify({ error: "limited" }), JSON.stringify({ error: { message: "Rate limit reached for requests." } })]) {
    assert.deepEqual(limitHint(nothing), { waitMs: null, lasting: false }, String(nothing));
  }
  assert.deepEqual(limitHint("Rate limit exceeded. Retry after 30 seconds."), { waitMs: 30_000, lasting: false }, "an answer that is not JSON is read as text");
});

test("a wait in words", () => {
  assert.equal(waitWords(400), "1 second");
  assert.equal(waitWords(45_400), "45 seconds");
  assert.equal(waitWords(89_000), "89 seconds");
  assert.equal(waitWords(120_000), "2 minutes");
  assert.equal(waitWords(60 * 60_000), "60 minutes");
  assert.equal(waitWords(120 * 60_000), "2 hours");
  assert.equal(waitWords(62_285_925), "17 hours and 18 minutes");
  assert.equal(waitWords(61 * 60_000 + 30 * 60_000), "1 hour and 31 minutes");
});

// ─── The message of a quota that is used up ──────────────────────────────────

test("Google's message for a used-up quota is told in fewer words, with how the quota is counted", () => {
  const day = upstreamErrorMessage(429, PER_DAY);
  assert.equal(
    day,
    "Provider responded 429: You exceeded your current quota, please check your plan and billing details. " +
      "Quota exceeded: generate content free tier requests, limit 20 per day, model gemini-3.6-flash. Please retry in 17 hours and 18 minutes.",
  );
  assert.ok(day.length <= 300, "what a task shows of it is all of it");
  assert.match(upstreamErrorMessage(429, PER_MINUTE), /limit 5 per minute, model gemini-3\.5-flash\. Please retry in 46 seconds\.$/);
  const none = upstreamErrorMessage(429, NO_ALLOWANCE);
  assert.match(none, /input token count, limit 0 per minute, model gemini-2\.0-flash; generate content free tier requests, limit 0 per minute, model gemini-2\.0-flash; generate content free tier requests, limit 0 per day, model/);
  assert.ok(!none.includes("[redacted]") && !none.endsWith("…"), none);
  // As it was shown before: cut in the middle of the quota's name, before the allowance, the model and the wait.
  const raw = (JSON.parse(PER_DAY) as { error: { message: string } }).error.message;
  assert.ok(raw.length > 300 && !raw.slice(0, 300).includes("limit: 20"));
});

test("a quota message without the details loses only the addresses; any other message stays as it is", () => {
  const plain = JSON.stringify({ error: { code: 429, message: `${HEAD}\n* Quota exceeded for metric: ${METRIC}, limit: 50\nPlease retry in 34.074824224s.`, status: "RESOURCE_EXHAUSTED" } });
  assert.equal(
    upstreamErrorMessage(429, plain),
    "Provider responded 429: You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 50 Please retry in 34.074824224s.",
  );
  assert.equal(upstreamErrorMessage(429, JSON.stringify({ error: { message: "Resource has been exhausted (e.g. check quota)." } })), "Provider responded 429: Resource has been exhausted (e.g. check quota).");
  // Not a limit: nothing of it is rewritten, whatever it says.
  assert.equal(upstreamErrorMessage(400, PER_DAY).startsWith("Provider responded 400: You exceeded your current quota, please check your plan and billing details. For more information"), true);
});

// ─── The error a "not now" becomes ───────────────────────────────────────────

test("an error for a \"not now\" keeps what the answer said about the wait", () => {
  const day = upstreamError(429, upstreamErrorMessage(429, PER_DAY), { body: PER_DAY });
  assert.ok(day instanceof AppError);
  assert.deepEqual([day.status, day.code], [502, "upstream_error"]);
  assert.deepEqual(limitOf(day), { status: 429, waitMs: 62_285_925, lasting: true });
  assert.deepEqual(limitOf(upstreamError(429, "Provider responded 429: x", { body: PER_MINUTE })), { status: 429, waitMs: 46_131, lasting: false });
  // The header goes before the body.
  assert.deepEqual(limitOf(upstreamError(429, "Provider responded 429: x", { body: PER_MINUTE, retryAfter: "120" })), { status: 429, waitMs: 120_000, lasting: false });
  assert.deepEqual(limitOf(upstreamError(503, "Provider responded 503: busy", { body: "busy" })), { status: 503, waitMs: null, lasting: false });
  assert.deepEqual(limitOf(upstreamError(529, "Provider responded 529: overloaded")), { status: 529, waitMs: null, lasting: false });
});

test("an error that is not a \"not now\" tells of no limit", () => {
  assert.equal(limitOf(upstreamError(400, "Provider responded 400: no tools", { body: PER_DAY, retryAfter: "5" })), null);
  assert.equal(limitOf(upstreamError(500, "Provider responded 500: broken")), null);
  assert.equal(limitOf(new AppError(504, "timeout", "Upstream request timed out")), null);
  assert.equal(limitOf(new AppError(502, "empty_answer", "The agent returned an empty answer")), null);
  assert.equal(limitOf(new Error("anything")), null);
  for (const nothing of [null, undefined, "Provider responded 429: x", 429]) assert.equal(limitOf(nothing), null);
  // An error from a part that does not mark it is read by the status in its message.
  assert.deepEqual(limitOf(new AppError(502, "upstream_error", "Provider responded 429: Rate limit reached")), { status: 429, waitMs: null, lasting: false });
  assert.deepEqual(limitOf({ message: "Provider responded 503: busy" }), { status: 503, waitMs: null, lasting: false });
  // The mark is read by its shape, also on an error that came through another part of the server.
  assert.deepEqual(limitOf({ message: "x", limit: { status: 429, waitMs: 1500, lasting: true } }), { status: 429, waitMs: 1500, lasting: true });
});

// ─── A request that is sent again ────────────────────────────────────────────

/** A provider that gives these answers in turn; the last one again and again. */
function provider(answers: { status: number; body?: string; headers?: Record<string, string> }[]) {
  let asked = 0;
  const once = async () => {
    const answer = answers[Math.min(asked, answers.length - 1)]!;
    asked++;
    return new Response(answer.body ?? "", { status: answer.status, headers: answer.headers });
  };
  return { once, asked: () => asked };
}

function clock() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test("the wait an answer names in its body is the one that is taken", async () => {
  const p = provider([{ status: 429, body: PER_MINUTE }, { status: 200, body: "fine" }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
  assert.equal(res.status, 200);
  assert.deepEqual(c.waits, [46_131 + 250], "what Google asks for and a little more, not three seconds");
  assert.equal(retryDelayMs(null, 0, 0, 46_131), 46_381);
  assert.equal(retryDelayMs("2", 0, 0, 46_131), 2250, "a header goes first");
  assert.equal(retryDelayMs(null, 0, 0, MAX_RETRY_WAIT_MS + 1), null);
  assert.equal(retryDelayMs(null, 2, 0, null), 25_000, "and without either, the app's own wait");
});

test("a quota for the day is not waited for, and its answer can still be read", async () => {
  for (const body of [PER_DAY, PER_DAY_SHORT, NO_ALLOWANCE]) {
    const p = provider([{ status: 429, body, headers: { "content-type": "application/json", "content-encoding": "identity" } }, { status: 200 }]);
    const c = clock();
    const patience = new Patience();
    const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep, key: "k", patience });
    assert.equal(res.status, 429);
    assert.equal(p.asked(), 1, "asked once: a second time would be answered the same");
    assert.deepEqual(c.waits, []);
    assert.equal(await res.text(), body, "the caller reads the answer as it was");
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(patience.has("k", Date.now()), true, "nothing was waited, so nothing was in vain");
  }
});

test("an answer that is given up after its body was read is passed on whole", async () => {
  const p = provider([{ status: 429, body: JSON.stringify({ error: { message: "Rate limit reached for requests." } }) }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 2, sleep: c.sleep });
  assert.equal(res.status, 429);
  assert.equal(p.asked(), 3);
  assert.deepEqual(c.waits, [3000, 10_000], "an answer that names no wait gets the app's own");
  assert.deepEqual(await res.json(), { error: { message: "Rate limit reached for requests." } });
});

test("a body that is no short text is left alone", async () => {
  // Longer than an error is: it is not read, and the caller gets it untouched.
  const long = "x".repeat(70_000);
  const big = provider([{ status: 429, body: long, headers: { "content-length": String(long.length) } }]);
  const res = await fetchWithRetries(big.once, { limit: 1, sleep: clock().sleep });
  assert.equal((await res.text()).length, long.length);
  // A stream of events is not an error message.
  const stream = provider([{ status: 503, body: "data: Please retry in 1s.\n\n", headers: { "content-type": "text/event-stream" } }]);
  const c = clock();
  await fetchWithRetries(stream.once, { limit: 1, sleep: c.sleep });
  assert.deepEqual(c.waits, [3000], "what it says is not taken for a wait");
});

// ─── A task that waits for its models ────────────────────────────────────────

test("RUN_LIMIT_WAIT_MINUTES: an hour unless set, 0 for off", () => {
  assert.equal(LIMIT_WAIT_DEFAULT_MINUTES, 60);
  for (const unset of [undefined, null, "", "  ", "soon", "-5"]) assert.equal(limitWaitMs(unset), 60 * 60_000, String(unset));
  for (const off of ["0", "off", "OFF", "false", "no"]) assert.equal(limitWaitMs(off), 0, off);
  assert.equal(limitWaitMs("15"), 15 * 60_000);
  assert.equal(limitWaitMs(" 90 "), 90 * 60_000);
  assert.equal(limitWaitMs("100000"), LIMIT_WAIT_MAX_MINUTES * 60_000);
  // For the checks of this app: seconds.
  assert.equal(limitWaitMs("60", "8"), 8000);
  assert.equal(limitWaitMs(undefined, "0"), 0);
  assert.equal(limitWaitMs("15", ""), 15 * 60_000);
  assert.equal(limitWaitMs("15", "soon"), 15 * 60_000);
});

test("the waits of an hour: a minute, two, five, ten, then every quarter of an hour, and no longer than the hour", () => {
  const hour = 60 * 60_000;
  const limited = [{ waitMs: null, lasting: false }];
  const waits: number[] = [];
  let waited = 0;
  for (let round = 0; round < 20; round++) {
    const wait = nextLimitWait({ round, waitedMs: waited, totalMs: hour, limited });
    if (wait === null) break;
    waits.push(wait / 60_000);
    waited += wait;
  }
  assert.deepEqual(waits, [1, 2, 5, 10, 15, 15, 12]);
  assert.equal(waited, hour);
  // Another total keeps the proportions.
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: 30 * 60_000, limited }), 30_000);
  assert.equal(nextLimitWait({ round: 4, waitedMs: 0, totalMs: 30 * 60_000, limited }), 7.5 * 60_000);
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: 6000, limited }), 250, "never less than a quarter of a second");
});

test("a task does not wait when waiting is off, when no model said \"not now\", or when no limit can end in time", () => {
  const hour = 60 * 60_000;
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: 0, limited: [{ waitMs: null, lasting: false }] }), null);
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [] }), null, "they failed for other reasons");
  assert.equal(nextLimitWait({ round: 3, waitedMs: hour, totalMs: hour, limited: [{ waitMs: null, lasting: false }] }), null, "the time is used up");
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 62_285_925, lasting: true }] }), null, "a quota for the day");
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 34_000, lasting: true }] }), null, "also when its answer asks for half a minute");
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 2 * hour, lasting: false }] }), null, "it asks for longer than the task waits");
  assert.equal(nextLimitWait({ round: 2, waitedMs: 50 * 60_000, totalMs: hour, limited: [{ waitMs: 11 * 60_000, lasting: false }] }), null, "longer than what is left");
  // One model whose limit can end is enough.
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 62_285_925, lasting: true }, { waitMs: null, lasting: false }] }), 60_000);
});

test("models that name their wait are not asked before the first of those waits is over", () => {
  const hour = 60 * 60_000;
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 12 * 60_000, lasting: false }, { waitMs: 20 * 60_000, lasting: false }] }), 12 * 60_000 + 500);
  assert.equal(nextLimitWait({ round: 4, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 30_000, lasting: false }] }), 15 * 60_000, "nor sooner than its turn");
  // One that names none may be back any moment: the usual wait.
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 12 * 60_000, lasting: false }, { waitMs: null, lasting: false }] }), 60_000);
  // One whose limit lasts is not counted.
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: hour, limited: [{ waitMs: 5 * 60_000, lasting: false }, { waitMs: 1000, lasting: true }] }), 5 * 60_000 + 500);
  assert.equal(nextLimitWait({ round: 0, waitedMs: 58 * 60_000, totalMs: hour, limited: [{ waitMs: 90_000, lasting: false }] }), 90_500);
  assert.equal(nextLimitWait({ round: 0, waitedMs: 59 * 60_000, totalMs: hour, limited: [{ waitMs: 59_800, lasting: false }] }), 60_000, "not beyond the time that is left");
});

test("a task whose models all failed says what each of them said", () => {
  assert.equal(failureText([], "No model available"), "No model available");
  assert.equal(failureText([{ model: "M (P)", error: "Provider responded 429: limited" }], "x"), "Provider responded 429: limited", "one model: its words, as before");
  assert.equal(
    failureText(
      [
        { model: "north-mini-code (Kilo Gateway)", error: "Provider responded 429: come back later" },
        { model: "Qwen3.6-27B (OVHcloud AI Endpoints)", error: "Upstream request timed out" },
        { model: "gemini-3.6-flash (gemini)", error: "Provider responded 429: quota" },
      ],
      "Provider responded 429: quota",
    ),
    "None of the 3 models of this task gave an answer.\n" +
      "• north-mini-code (Kilo Gateway): Provider responded 429: come back later\n" +
      "• Qwen3.6-27B (OVHcloud AI Endpoints): Upstream request timed out\n" +
      "• gemini-3.6-flash (gemini): Provider responded 429: quota",
  );
  assert.equal(
    failureText([{ model: "M (P)", error: "Provider responded 429: limited" }], "x", "60 minutes"),
    "Provider responded 429: limited\n\nThe task waited 60 minutes for the limit to end, and it did not.",
  );
  assert.match(
    failureText([{ model: "A (P)", error: "a" }, { model: "B (P)", error: "b" }], "b", "60 minutes"),
    /^None of the 2 models of this task gave an answer, also after the task waited 60 minutes for their limits\.\n• A \(P\): a\n• B \(P\): b$/,
  );
});

test("a task that waits says so: to everyone without a word of the setup, to those who are shown it with the models", () => {
  const one = limitWaitNote("5 minutes", { limited: 1, of: 1 });
  assert.equal(one.message, "Not answered just now. Trying again in 5 minutes");
  assert.equal(one.full, 'Its model says "not now" (limited, or busy). Asking it again in 5 minutes');
  assert.equal(limitWaitNote("45 seconds", { limited: 3, of: 3 }).full, 'None of its 3 models answers: all said "not now" (limited, or busy). Asking them again in 45 seconds');
  assert.equal(limitWaitNote("45 seconds", { limited: 1, of: 3 }).full, 'None of its 3 models answers: 1 said "not now" (limited, or busy). Asking them again in 45 seconds');
  // What a user reads is the note itself, not the word that stands in for one that names the setup.
  for (const time of ["1 second", "12 minutes", "1 hour and 5 minutes"]) {
    const note = limitWaitNote(time, { limited: 2, of: 2 });
    assert.equal(publicText(note.message, null, WORKING), note.message);
    assert.equal(publicText(note.full, null, WORKING), WORKING);
  }
});
