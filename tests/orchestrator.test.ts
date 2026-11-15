import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJsonObject, mayBeAboutTools, parsePlan, topoOrder } from "../src/lib/orchestrator/plan";

test("extractJsonObject pulls JSON out of fenced prose", () => {
  const raw = 'Sure!\n```json\n{"tasks":[{"seq":1,"title":"a","objective":"o","agent":"Ada"}]}\n```\nDone.';
  const json = extractJsonObject(raw);
  assert.ok(json);
  assert.equal(JSON.parse(json!).tasks.length, 1);
});

test("parsePlan validates and normalizes seq + deps", () => {
  const raw = JSON.stringify({
    tasks: [
      { seq: 5, title: "Design", objective: "design it", agent: "Architect", dependsOn: [] },
      { seq: 9, title: "Build", objective: "build it", agent: "Engineer", dependsOn: [5, 99] },
    ],
  });
  const plan = parsePlan(raw);
  assert.ok(plan.ok);
  assert.deepEqual(plan.tasks.map((t) => t.seq), [1, 2]);
  // forward/invalid deps dropped; valid earlier dep kept (remapped)
  assert.deepEqual(plan.tasks[1]!.dependsOn, [1]);
});

test("parsePlan caps task count", () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1, title: `t${i}`, objective: "x", agent: "A", dependsOn: [],
  }));
  const plan = parsePlan(JSON.stringify({ tasks }), 12);
  assert.ok(plan.ok);
  assert.equal(plan.tasks.length, 12);
});

test("parsePlan rejects garbage", () => {
  assert.equal(parsePlan("no json here").ok, false);
  assert.equal(parsePlan('{"nope":true}').ok, false);
});

test("topoOrder respects dependencies", () => {
  const order = topoOrder([
    { seq: 1, dependsOn: [2] },
    { seq: 2, dependsOn: [3] },
    { seq: 3, dependsOn: [] },
  ]);
  assert.deepEqual(order, [3, 2, 1]);
});

test("topoOrder falls back to seq order on a cycle", () => {
  const order = topoOrder([
    { seq: 1, dependsOn: [2] },
    { seq: 2, dependsOn: [1] },
  ]);
  assert.deepEqual(order, [1, 2]);
});

test("mayBeAboutTools: a refused request may be about the tools, a busy provider is not", () => {
  const upstream = (status: number, text = "…") => ({ code: "upstream_error", message: `Provider responded ${status}: ${text}` });
  assert.equal(mayBeAboutTools(upstream(400, "This model does not support tools.")), true);
  assert.equal(mayBeAboutTools(upstream(404, "No endpoints found that support tool use")), true);
  assert.equal(mayBeAboutTools(upstream(422)), true);
  for (const status of [408, 429, 500, 502, 503, 529]) {
    assert.equal(mayBeAboutTools(upstream(status)), false, `${status} says nothing about tools`);
  }
  assert.equal(mayBeAboutTools({ code: "timeout", message: "Upstream request timed out" }), false);
  assert.equal(mayBeAboutTools({ code: "network_error", message: "Could not reach provider" }), false);
  // Anything else is left as it was: the request is tried once more without tools.
  assert.equal(mayBeAboutTools({ code: "upstream_error", message: "Provider error: tools are not supported" }), true);
  assert.equal(mayBeAboutTools({ message: "The provider answered without content" }), true);
});
