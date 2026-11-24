import { test } from "node:test";
import assert from "node:assert/strict";
import { compareModels, rankOf, sortModels } from "../src/lib/model-rank";

const named = (ids: string[]) => ids.map((id) => ({ modelId: id, name: id }));
const order = (ids: string[]) => sortModels(named(ids)).map((m) => m.modelId);

test("the models of Anthropic as its own list has them: the newest of each class first, then the older ones", () => {
  // What the owner of this installation sees in the app of the provider: the first list, then "more models".
  const theirs = ["claude-opus-4-6", "claude-sonnet-5", "claude-fable-5", "claude-haiku-5-5", "claude-opus-5", "claude-fable-5-2", "claude-opus-3", "claude-sonnet-4-6", "claude-opus-4-8", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-4-7", "claude-opus-5-5"];
  assert.deepEqual(order(theirs), [
    // The newest of each class, the highest class first.
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    // What they took the place of: the highest version first, the oldest last.
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-3",
  ]);
  assert.equal(rankOf("claude-fable-5-2").tier > rankOf("claude-opus-5-5").tier, true);
});

test("the models of Anthropic: the highest version first, and in a version opus before sonnet before haiku", () => {
  const shuffled = [
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1-20250805",
    "claude-sonnet-5-5",
    "claude-3-haiku-20240307",
    "claude-opus-5-5",
    "claude-sonnet-4-5-20250929",
    "claude-3-5-sonnet-20241022",
    "claude-haiku-5-5",
    "claude-opus-4-5-20251101",
    "claude-3-opus-20240229",
  ];
  assert.deepEqual(order(shuffled), [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1-20250805",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
  ]);
});

test("a date or a build in a name is not its version", () => {
  assert.deepEqual(rankOf("claude-sonnet-4-5-20250929").version, [4, 5]);
  assert.equal(rankOf("claude-sonnet-4-5-20250929").date, 20250929);
  assert.deepEqual(rankOf("claude-3-5-sonnet-20241022").version, [3, 5]);
  assert.deepEqual(rankOf("gpt-4o-2024-08-06").version, [4, 0]);
  assert.deepEqual(rankOf("gemini-2.5-flash-preview-05-20").version, [2, 5]);
  assert.deepEqual(rankOf("mistral-large-2411").version, [-1, 0]);
  assert.equal(rankOf("mistral-large-2411").date, 202411);
  assert.deepEqual(rankOf("command-r-08-2024").version, [-1, 0]);
  assert.equal(rankOf("command-r-08-2024").date, 202408);
  // The same model of a later date stands above the earlier one.
  assert.deepEqual(order(["mistral-large-2407", "mistral-large-2411"]), ["mistral-large-2411", "mistral-large-2407"]);
});

test("what a gateway puts around a name is not part of it", () => {
  assert.deepEqual(rankOf("anthropic/claude-opus-4.5").version, [4, 5]);
  assert.equal(rankOf("anthropic/claude-opus-4.5").family, "claude");
  assert.equal(rankOf("google/gemini-2.5-pro:free").family, "gemini");
  assert.deepEqual(rankOf("google/gemini-2.5-pro:free").version, [2, 5]);
  assert.equal(rankOf("Meta-Llama-3_3-70B-Instruct").family, "llama");
  assert.deepEqual(rankOf("Meta-Llama-3_3-70B-Instruct").version, [3, 3]);
  assert.equal(rankOf("Meta-Llama-3_3-70B-Instruct").size, 70);
  // How much it reads is not its version either.
  assert.deepEqual(rankOf("gpt-4-32k").version, [4, 0]);
});

test("in a version, the class counts: pro before flash before lite, and the lowest word of a name", () => {
  assert.deepEqual(order(["gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-flash", "gemini-2.0-flash"]), [
    // The newest pro, the newest flash, the newest lite; then the flashes the newest one took the place of.
    "gemini-2.5-pro",
    "gemini-3-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
  ]);
  // Two models alone, compared: the higher version stands above, whatever its class.
  assert.equal(compareModels({ modelId: "gemini-3-flash", name: "a" }, { modelId: "gemini-2.5-pro", name: "b" }) < 0, true);
  assert.equal(compareModels({ modelId: "gemini-2.5-pro", name: "a" }, { modelId: "gemini-2.5-flash", name: "b" }) < 0, true);
  assert.deepEqual(order(["gpt-5-nano", "gpt-5", "gpt-5-mini", "gpt-5-pro", "gpt-4.1"]), ["gpt-5-pro", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1"]);
  assert.equal(rankOf("gemini-2.5-flash-lite").tier < rankOf("gemini-2.5-flash").tier, true);
});

test("the lines of models stay together, the well-known first, the others by name", () => {
  const mixed = ["qwen3-coder", "gemini-2.5-pro", "zeta-1", "claude-sonnet-4-5", "gpt-5", "alpha-2", "deepseek-v3", "claude-opus-4-5", "llama-3.3-70b", "llama-3.1-8b"];
  // The newest of every line first, line by line; the llama that a newer one took the place of comes after them all.
  assert.deepEqual(order(mixed), ["claude-opus-4-5", "claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro", "deepseek-v3", "qwen3-coder", "llama-3.3-70b", "alpha-2", "zeta-1", "llama-3.1-8b"]);
  // Open weights numbered by size are a line of their own, not a version of GPT.
  assert.equal(rankOf("gpt-oss-120b").family, "gpt-oss");
  assert.deepEqual(order(["gpt-oss-20b", "gpt-oss-120b"]), ["gpt-oss-120b", "gpt-oss-20b"]);
});

test("where both have a price, the dearer of two that are otherwise alike stands above", () => {
  const a = { modelId: "nova-a", name: "Nova A", outputPrice: 2 };
  const b = { modelId: "nova-b", name: "Nova B", outputPrice: 10 };
  assert.deepEqual(sortModels([a, b]).map((m) => m.modelId), ["nova-b", "nova-a"]);
  // Without a price on both, by name.
  assert.deepEqual(sortModels([{ ...b, outputPrice: null }, a]).map((m) => m.modelId), ["nova-a", "nova-b"]);
});

test("a model an owner put somewhere stands there, before the ones that go by their names", () => {
  const list = [
    { modelId: "claude-opus-5-5", name: "Opus 5.5" },
    { modelId: "claude-haiku-3", name: "Haiku 3", position: 1 },
    { modelId: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { modelId: "claude-sonnet-4", name: "Sonnet 4", position: 0 },
  ];
  assert.deepEqual(sortModels(list).map((m) => m.modelId), ["claude-sonnet-4", "claude-haiku-3", "claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.equal(compareModels(list[1]!, list[0]!) < 0, true);
  // The list it was given is not changed.
  assert.equal(list[0]!.modelId, "claude-opus-5-5");
});

test("a name that says \"latest\" stands above the numbered ones of its line", () => {
  assert.deepEqual(order(["mistral-small-2503", "mistral-small-latest"]), ["mistral-small-latest", "mistral-small-2503"]);
});
