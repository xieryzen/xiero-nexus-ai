import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ChatResult } from "../src/lib/adapters/types";
import { CONTINUE, askWhole, joinParts, repeatedStart, wasCut } from "../src/lib/agent/whole";

const BASE: ChatMessage[] = [
  { role: "system", content: "You write documents." },
  { role: "user", content: "Write the PRD." },
];

/** A model that answers from a list, and remembers what it was asked. */
function scripted(answers: (ChatResult | Error)[]) {
  const asked: ChatMessage[][] = [];
  let i = 0;
  return {
    asked,
    ask: async (messages: ChatMessage[]) => {
      asked.push([...messages]);
      const next = answers[Math.min(i++, answers.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("a reply that was cut at its length limit is told from one that ended", () => {
  // As the providers write it: OpenAI, Anthropic, Gemini.
  for (const reason of ["length", "max_tokens", "MAX_TOKENS", "max_output_tokens", " Length "]) assert.equal(wasCut(reason), true, reason);
  // Done, a call, a refusal, a context that is full (going on would not help), nothing said.
  for (const reason of ["stop", "end_turn", "STOP", "tool_calls", "tool_use", "content_filter", "SAFETY", "model_length", "", undefined, null]) {
    assert.equal(wasCut(reason), false, String(reason));
  }
});

test("an answer that was cut goes on until it is whole, and the pieces are one text", async () => {
  const model = scripted([
    { content: "# PRD\n\n## 1. Goal\nThe shop sells ench", finishReason: "length" },
    { content: "antments from a menu.\n\n## 2. Scope\nLevels and a con", finishReason: "length" },
    { content: "firmation.\n\n## 3. Done", finishReason: "stop" },
  ]);
  const whole = await askWhole(model.ask, BASE);
  assert.equal(whole.content, "# PRD\n\n## 1. Goal\nThe shop sells enchantments from a menu.\n\n## 2. Scope\nLevels and a confirmation.\n\n## 3. Done");
  assert.deepEqual([whole.continued, whole.cut], [2, false]);
  // Each time the model is shown what it wrote, and asked to go on from there.
  assert.equal(model.asked.length, 3);
  assert.deepEqual(model.asked[1]!.slice(2), [
    { role: "assistant", content: "# PRD\n\n## 1. Goal\nThe shop sells ench" },
    { role: "user", content: CONTINUE },
  ]);
  assert.equal(model.asked[2]!.length, 6);
  assert.equal(model.asked[2]!.at(-2)!.content, "antments from a menu.\n\n## 2. Scope\nLevels and a con");
  // The conversation it was given is not changed.
  assert.equal(BASE.length, 2);
});

test("an answer that ended is asked once", async () => {
  const model = scripted([{ content: "Short.", finishReason: "stop" }]);
  const whole = await askWhole(model.ask, BASE);
  assert.deepEqual([whole.content, whole.continued, whole.cut, model.asked.length], ["Short.", 0, false, 1]);
  // No reason given: taken as ended.
  const silent = scripted([{ content: "No reason." }]);
  assert.deepEqual([(await askWhole(silent.ask, BASE)).cut, silent.asked.length], [false, 1]);
});

test("it goes on only so often, and then says that it is still cut", async () => {
  const model = scripted([{ content: "more and ", finishReason: "length" }]);
  const whole = await askWhole(model.ask, BASE, { max: 3 });
  assert.deepEqual([whole.content, whole.continued, whole.cut, model.asked.length], ["more and more and more and more and ", 3, true, 4]);
  // None at all: as it came.
  const none = scripted([{ content: "half", finishReason: "length" }]);
  assert.deepEqual([(await askWhole(none.ask, BASE, { max: 0 })).cut, none.asked.length], [true, 1]);
  // Stopped by whoever runs it.
  const stopped = scripted([{ content: "half", finishReason: "length" }]);
  assert.deepEqual([(await askWhole(stopped.ask, BASE, { stop: () => true })).cut, stopped.asked.length], [true, 1]);
});

test("going on that fails, or writes nothing, keeps what was written: it is cut, not lost", async () => {
  const failing = scripted([{ content: "The first half", finishReason: "length" }, new Error("The provider is down.")]);
  const kept = await askWhole(failing.ask, BASE);
  assert.deepEqual([kept.content, kept.continued, kept.cut], ["The first half", 0, true]);
  const silent = scripted([{ content: "The first half", finishReason: "length" }, { content: "  ", finishReason: "stop" }]);
  const still = await askWhole(silent.ask, BASE);
  assert.deepEqual([still.content, still.continued, still.cut], ["The first half", 1, true]);
  // The first call failing is a failure: there is nothing to keep.
  await assert.rejects(askWhole(scripted([new Error("down")]).ask, BASE), /down/);
  // A reply that is cut with nothing in it (all of it went into thinking) is not gone on with.
  const empty = scripted([{ content: "", finishReason: "length" }]);
  assert.deepEqual([(await askWhole(empty.ask, BASE)).cut, empty.asked.length], [false, 1]);
});

test("a provider's own form of the turn goes back with what was written", async () => {
  const raw = { adapter: "anthropic", content: [{ type: "thinking" }, { type: "text", text: "Half" }] };
  const model = scripted([{ content: "Half", finishReason: "max_tokens", raw }, { content: " and half.", finishReason: "end_turn" }]);
  await askWhole(model.ask, BASE);
  assert.deepEqual(model.asked[1]!.at(-2), { role: "assistant", content: "Half", raw });
});

test("what a model says again when it goes on is left out once", () => {
  // The line it was cut in, begun again.
  assert.equal(joinParts("## Scope\n- The player picks an ench", "- The player picks an enchantment and a level."), "## Scope\n- The player picks an enchantment and a level.");
  // The sentence it was cut in.
  assert.equal(joinParts("It opens a menu. The plugin also suppo", "The plugin also supports Vault."), "It opens a menu. The plugin also supports Vault.");
  // The word it was cut in.
  assert.equal(joinParts("the player confirms the purch", "purchase with yes or no"), "the player confirms the purchase with yes or no");
  // Several words of it, from where a word begins.
  assert.equal(joinParts("In the menu the player confirms the purch", "the player confirms the purchase with yes or no"), "In the menu the player confirms the purchase with yes or no");
  // More than the last line: from where an earlier line begins.
  assert.equal(joinParts("a: 1\nmessages:\n  prefix: \"[Shop]\"\n  bought: \"You bou", "messages:\n  prefix: \"[Shop]\"\n  bought: \"You bought it\""), "a: 1\nmessages:\n  prefix: \"[Shop]\"\n  bought: \"You bought it\"");
  // Gone on correctly, in the middle of a word: nothing is taken away.
  assert.equal(joinParts("the player confirms the purch", "ase with yes or no"), "the player confirms the purchase with yes or no");
  assert.equal(joinParts("", "all of it"), "all of it");
  assert.equal(joinParts("all of it", ""), "all of it");
});

test("text that only looks alike is left alone", () => {
  // A row of a table, a list of the same values, numbers, short words that double: each went on correctly.
  assert.equal(joinParts("| a | b |\n|---|---|", "---|---|\n| 1 | 2 |"), "| a | b |\n|---|---|---|---|\n| 1 | 2 |");
  assert.equal(joinParts("flags: [false, false, ", "false, false, true]"), "flags: [false, false, false, false, true]");
  assert.equal(joinParts("values: false, false, false, false, ", "false, false, false, true"), "values: false, false, false, false, false, false, false, true");
  assert.equal(joinParts("| a | b | c | d |\n|---|---", "|---|---|\n| 1 | 2 | 3 | 4 |"), "| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |");
  assert.equal(joinParts("row: 0, 0, 0, 0, 0, 0, 0, 0, ", "0, 0, 0, 0, 0, 0, 0, 0, 1"), "row: 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1");
  assert.equal(joinParts("id: 10", "10 20"), "id: 1010 20");
  assert.equal(joinParts("she said ma", "ma is here"), "she said mama is here");
  // Cut at the end of a line: the same line twice is two lines.
  assert.equal(joinParts("  </div>\n", "  </div>\n</body>"), "  </div>\n  </div>\n</body>");
  assert.equal(joinParts("- false\n", "- false\n- true"), "- false\n- false\n- true");
  assert.equal(repeatedStart("- false\n", "- false\n- true"), 0);
  assert.equal(repeatedStart("the purch", "purchase"), 5);
});

test("a block of code that was open is not opened a second time", () => {
  const before = "The class:\n```java\npublic class Shop {\n    private int lev";
  assert.equal(joinParts(before, "```java\nel = 1;\n}\n```\nDone."), "The class:\n```java\npublic class Shop {\n    private int level = 1;\n}\n```\nDone.");
  // And with the line begun again inside it.
  assert.equal(joinParts(before, "```java\n    private int level = 1;\n}\n```"), "The class:\n```java\npublic class Shop {\n    private int level = 1;\n}\n```");
  // Its closing mark is one: it is kept.
  assert.equal(joinParts("```java\nint a = 1;\n", "```\nDone."), "```java\nint a = 1;\n```\nDone.");
  // No block was open: a new one is a new one.
  assert.equal(joinParts("First:\n```\na\n```\nSecond", ":\n```yaml\nb: 1\n```"), "First:\n```\na\n```\nSecond:\n```yaml\nb: 1\n```");
});
