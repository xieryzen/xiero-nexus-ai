import { test } from "node:test";
import assert from "node:assert/strict";
import { isMediaOnly } from "../src/lib/capabilities";
import { askingOrder, priceCeiling, standInsEnabled, standInsFor, type StandInModel } from "../src/lib/model-choice-rules";
import {
  REST_MAX_MS,
  RETRY_AT_MAX_MS,
  USE_FAILURES_TO_HIDE,
  afterUseFailure,
  isDue,
  isResting,
  nextCheckAt,
  restMs,
  usableNow,
  failuresAfterCheck,
  outcomeOfUse,
} from "../src/lib/model-health-rules";

const MINUTE = 60_000;
const SIX_HOURS = 6 * 60 * MINUTE;
const NOW = 1_800_000_000_000;

test("what a failed request says about its model", () => {
  assert.deepEqual(outcomeOfUse({ code: "timeout", message: "Upstream request timed out" }), { kind: "down" });
  assert.deepEqual(outcomeOfUse({ code: "network_error", message: "Could not reach the provider" }), { kind: "down" });
  // No such model, a key that is not accepted, no credit: asking again changes nothing.
  for (const status of [401, 402, 404, 410]) {
    assert.deepEqual(outcomeOfUse({ code: "upstream_error", message: `Provider responded ${status}: no` }), { kind: "refused" }, String(status));
  }
  // "Not now", with what the provider said about its limit.
  assert.deepEqual(outcomeOfUse({ message: "Provider responded 429: slow down", limit: { waitMs: 34_000, lasting: false } }), { kind: "limited", waitMs: 34_000, lasting: false });
  assert.deepEqual(outcomeOfUse({ message: "Provider responded 429: quota for the day", limit: { waitMs: null, lasting: true } }), { kind: "limited", waitMs: null, lasting: true });
  assert.deepEqual(outcomeOfUse({ message: "Provider responded 503: busy" }), { kind: "limited", waitMs: null, lasting: false });
  // An error of the provider, and a refusal that may be of this one request.
  for (const status of [403, 408, 500, 502, 504]) {
    assert.deepEqual(outcomeOfUse({ message: `Provider responded ${status}: x` }), { kind: "down" }, String(status));
  }
  // The request's own fault says nothing about the model: too long, a parameter it does not take.
  for (const message of ["Provider responded 400: context too long", "Provider responded 422: bad tools", "The agent returned an empty answer", "Model is disabled"]) {
    assert.deepEqual(outcomeOfUse({ code: "bad_request", message }), { kind: "none" }, message);
  }
});

test("a model that does not answer rests, and three in a row put it away", () => {
  const fresh = { failing: false, useFailures: 0 };
  assert.equal(afterUseFailure(fresh, { kind: "none" }, NOW), null);
  // The first: a minute's rest, and it stays in the lists.
  assert.deepEqual(afterUseFailure(fresh, { kind: "down" }, NOW), { useFailures: 1, failing: false, retryAt: NOW + MINUTE });
  assert.deepEqual(afterUseFailure({ failing: false, useFailures: 1 }, { kind: "down" }, NOW), { useFailures: 2, failing: false, retryAt: NOW + 2 * MINUTE });
  // The third puts it away.
  assert.deepEqual(afterUseFailure({ failing: false, useFailures: 2 }, { kind: "down" }, NOW), { useFailures: USE_FAILURES_TO_HIDE, failing: true, retryAt: NOW + 4 * MINUTE });
  // The rest grows to a quarter of an hour and no further.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(restMs), [MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, REST_MAX_MS, REST_MAX_MS, REST_MAX_MS]);
});

test("a provider that says how long is taken at its word, up to a day", () => {
  const fresh = { failing: false, useFailures: 0 };
  assert.deepEqual(afterUseFailure(fresh, { kind: "limited", waitMs: 34_000, lasting: false }, NOW), { useFailures: 1, failing: false, retryAt: NOW + 34_000 });
  assert.deepEqual(afterUseFailure(fresh, { kind: "limited", waitMs: 7 * 24 * 3_600_000, lasting: false }, NOW), { useFailures: 1, failing: false, retryAt: NOW + RETRY_AT_MAX_MS });
  // A limit that does not end soon puts the model away at once, until the time that was named.
  assert.deepEqual(afterUseFailure(fresh, { kind: "limited", waitMs: 17 * 3_600_000, lasting: true }, NOW), { useFailures: 1, failing: true, retryAt: NOW + 17 * 3_600_000 });
  assert.deepEqual(afterUseFailure(fresh, { kind: "limited", waitMs: null, lasting: true }, NOW), { useFailures: 1, failing: true, retryAt: null });
  // So does an answer that asking again does not change.
  assert.deepEqual(afterUseFailure(fresh, { kind: "refused" }, NOW), { useFailures: 1, failing: true, retryAt: null });
  // A model that is put away stays so.
  assert.equal(afterUseFailure({ failing: true, useFailures: 1 }, { kind: "down" }, NOW)?.failing, true);
});

test("a model that real work put away comes back on probation", () => {
  assert.equal(failuresAfterCheck(0), 0);
  assert.equal(failuresAfterCheck(2), 0);
  // It passed a check of one word: the next request of real work that fails puts it away again.
  assert.equal(failuresAfterCheck(3), 2);
  assert.equal(failuresAfterCheck(9), 2);
  assert.equal(afterUseFailure({ failing: false, useFailures: failuresAfterCheck(3) }, { kind: "down" }, NOW)?.failing, true);
});

test("resting, and what the app may choose now", () => {
  assert.equal(isResting({ retryAt: null }, NOW), false);
  assert.equal(isResting({}, NOW), false);
  assert.equal(isResting({ retryAt: NOW + 1 }, NOW), true);
  assert.equal(isResting({ retryAt: new Date(NOW) }, NOW), false);
  assert.equal(usableNow({ lastTestStatus: "ok", retryAt: null }, NOW), true);
  assert.equal(usableNow({ lastTestStatus: null, retryAt: null }, NOW), true);
  assert.equal(usableNow({ lastTestStatus: "ok", retryAt: NOW + MINUTE }, NOW), false);
  assert.equal(usableNow({ lastTestStatus: "error", retryAt: null }, NOW), false);
});

test("when the check asks a model that real work knows something about", () => {
  const tested = NOW - 10 * MINUTE;
  // Nothing known from use: as before.
  assert.equal(nextCheckAt({ lastTestedAt: tested, lastTestStatus: "ok", checkFailures: 0 }, SIX_HOURS), tested + SIX_HOURS);
  // It did not answer in real work and rests: asked when the rest is over, to clear it or put it away.
  assert.equal(nextCheckAt({ lastTestedAt: tested, lastTestStatus: "ok", checkFailures: 0, useFailures: 1, retryAt: NOW + MINUTE }, SIX_HOURS), NOW + MINUTE);
  assert.equal(isDue({ lastTestedAt: tested, lastTestStatus: "ok", checkFailures: 0, useFailures: 1, retryAt: NOW + MINUTE }, NOW, SIX_HOURS), false);
  assert.equal(isDue({ lastTestedAt: tested, lastTestStatus: "ok", checkFailures: 0, useFailures: 1, retryAt: NOW + MINUTE }, NOW + MINUTE, SIX_HOURS), true);
  //   never later than the regular check.
  assert.equal(nextCheckAt({ lastTestedAt: tested, lastTestStatus: "ok", checkFailures: 0, useFailures: 1, retryAt: tested + 2 * SIX_HOURS }, SIX_HOURS), tested + SIX_HOURS);
  // A failing model: after its wait, and not before the time its provider named.
  assert.equal(nextCheckAt({ lastTestedAt: tested, lastTestStatus: "error", checkFailures: 1 }, SIX_HOURS), tested + 15 * MINUTE);
  assert.equal(nextCheckAt({ lastTestedAt: tested, lastTestStatus: "error", checkFailures: 1, retryAt: tested + 17 * 60 * MINUTE }, SIX_HOURS), tested + 17 * 60 * MINUTE);
  assert.equal(nextCheckAt({ lastTestedAt: tested, lastTestStatus: "error", checkFailures: 1, retryAt: new Date(tested + MINUTE) }, SIX_HOURS), tested + 15 * MINUTE);
});

const model = (id: string, over: Partial<StandInModel> = {}): StandInModel => ({
  id,
  name: id,
  capabilities: ["text"],
  forUsers: false,
  failing: false,
  price: 0,
  providerId: "p1",
  resting: false,
  tools: false,
  ...over,
});

test("stand-ins: other models that work, one of each provider first", () => {
  const models = [
    model("a1", { providerId: "A" }),
    model("a2", { providerId: "A" }),
    model("a3", { providerId: "A" }),
    model("b1", { providerId: "B" }),
    model("c1", { providerId: "C" }),
    model("c2", { providerId: "C" }),
  ];
  // One of each provider before a second of any; four at most.
  assert.deepEqual(standInsFor(models, { own: [], ceiling: null, wantsTools: false }), ["a1", "b1", "c1", "a2"]);
  assert.deepEqual(standInsFor(models, { own: [], ceiling: null, wantsTools: false, max: 10 }), ["a1", "b1", "c1", "a2", "c2", "a3"]);
  // Never one the work is set to, one that is failing, or one that rests.
  assert.deepEqual(
    standInsFor([model("own"), model("failing", { failing: true }), model("resting", { resting: true }), model("fine")], { own: ["own"], ceiling: null, wantsTools: false }),
    ["fine"],
  );
  // Nor an image or an embedding model.
  assert.deepEqual(standInsFor([model("img", { capabilities: ["image_generation"] }), model("emb", { capabilities: ["embeddings"] }), model("chat")], { own: [], ceiling: null, wantsTools: false }), ["chat"]);
  assert.deepEqual(standInsFor([], { own: ["x"], ceiling: 0, wantsTools: true }), []);
});

test("stand-ins: never dearer than what the work was set to", () => {
  const models = [model("free"), model("cheap", { price: 2 }), model("dear", { price: 30 }), model("unpriced", { price: null })];
  // The work was set to free models: only a free one stands in, and none without a price.
  assert.deepEqual(standInsFor(models, { own: [], ceiling: 0, wantsTools: false }), ["free"]);
  assert.deepEqual(standInsFor(models, { own: [], ceiling: 5, wantsTools: false }), ["free", "cheap"]);
  // No ceiling: the cheapest first, one without a price last.
  assert.deepEqual(standInsFor(models, { own: [], ceiling: null, wantsTools: false }), ["free", "cheap", "dear", "unpriced"]);
  assert.equal(priceCeiling([0, 0]), 0);
  assert.equal(priceCeiling([0, 24, 3]), 24);
  // One of them has no price, or nothing is set: nothing to compare with.
  assert.equal(priceCeiling([0, null]), null);
  assert.equal(priceCeiling([]), null);
});

test("stand-ins: the marked ones only when some are marked, and tools for work with tools", () => {
  const models = [model("plain"), model("marked", { forUsers: true, price: 9 }), model("marked-too", { forUsers: true, price: 1 })];
  assert.deepEqual(standInsFor(models, { own: [], ceiling: null, wantsTools: false }), ["marked-too", "marked"]);
  // A marked one that fails does not open the door to the others.
  assert.deepEqual(standInsFor([model("plain"), model("marked", { forUsers: true, failing: true })], { own: [], ceiling: null, wantsTools: false }), []);
  const tools = [model("talks", { price: 0 }), model("takes-tools", { price: 5, tools: true })];
  assert.deepEqual(standInsFor(tools, { own: [], ceiling: null, wantsTools: true }), ["takes-tools", "talks"]);
  assert.deepEqual(standInsFor(tools, { own: [], ceiling: null, wantsTools: false }), ["talks", "takes-tools"]);
});

test("the order a piece of work asks its models in", () => {
  // The ones it is set to that can be used, the stand-ins, then the ones it is set to that cannot.
  assert.deepEqual(askingOrder(["first", "second", "manager"], new Set(["second", "s1", "s2"]), ["s1", "s2"]), ["second", "s1", "s2", "first", "manager"]);
  // All usable: as set, and the stand-ins behind them.
  assert.deepEqual(askingOrder(["first", "second"], new Set(["first", "second"]), ["s1"]), ["first", "second", "s1"]);
  // Named twice, asked once.
  assert.deepEqual(askingOrder(["m", "m", "n"], new Set(["m", "n"]), ["m", "s"]), ["m", "n", "s"]);
  assert.deepEqual(askingOrder([], new Set(), []), []);
});

test("stand-ins are on unless they are switched off", () => {
  for (const on of [undefined, null, "", "1", "on", "yes", "true"]) assert.equal(standInsEnabled(on), true, String(on));
  for (const off of ["0", "off", "OFF", " false ", "no"]) assert.equal(standInsEnabled(off), false, off);
});

test("a model that only writes down what is said is no chat model", () => {
  assert.equal(isMediaOnly(["audio"]), true);
  assert.equal(isMediaOnly(["audio", "streaming"]), true);
  // One that answers in text and also hears is.
  assert.equal(isMediaOnly(["audio", "text", "vision"]), false);
  assert.equal(isMediaOnly([]), false);
  assert.equal(isMediaOnly(["image_generation"]), true);
  assert.equal(isMediaOnly(["text", "image_generation"]), false);
});
