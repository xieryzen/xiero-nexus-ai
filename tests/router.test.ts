import assert from "node:assert/strict";
import { test } from "node:test";
import { pickCheapestModel, type RoutableModel } from "../src/lib/router";
import { parseVerdict } from "../src/lib/orchestrator/plan";

const models: RoutableModel[] = [
  { id: "cheap", inputPricePerMTok: 0.1, outputPricePerMTok: 0.2, capabilities: ["text"] },
  { id: "mid", inputPricePerMTok: 1, outputPricePerMTok: 2, capabilities: ["text", "vision"] },
  { id: "unknown", inputPricePerMTok: null, outputPricePerMTok: null, capabilities: ["text", "vision"] },
];

test("pickCheapestModel chooses lowest total price", () => {
  assert.equal(pickCheapestModel(models), "cheap");
});

test("pickCheapestModel respects a required capability", () => {
  // 'cheap' lacks vision, so 'mid' (priced) beats 'unknown' (no price).
  assert.equal(pickCheapestModel(models, "vision"), "mid");
});

test("pickCheapestModel returns null when nothing matches", () => {
  assert.equal(pickCheapestModel(models, "audio"), null);
  assert.equal(pickCheapestModel([], undefined), null);
});

test("models without price rank after priced ones", () => {
  const onlyUnknownPriced: RoutableModel[] = [
    { id: "a", inputPricePerMTok: null, outputPricePerMTok: null, capabilities: ["text"] },
    { id: "b", inputPricePerMTok: 5, outputPricePerMTok: 5, capabilities: ["text"] },
  ];
  assert.equal(pickCheapestModel(onlyUnknownPriced), "b");
});

test("parseVerdict reads the verdict line", () => {
  assert.equal(parseVerdict("Looks good overall.\nVERDICT: pass"), "pass");
  assert.equal(parseVerdict("Some issues remain. verdict: concerns"), "concerns");
  assert.equal(parseVerdict("Broken.\n\nVERDICT: fail\n"), "fail");
  assert.equal(parseVerdict("no verdict here"), null);
});
