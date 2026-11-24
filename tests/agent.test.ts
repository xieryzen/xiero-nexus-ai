import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ChatResult, ToolCall } from "../src/lib/adapters/types";
import { DEFAULT_MAX_STEPS, TOOL_CATALOG, TOOL_NAMES, isToolName, parseToolNames } from "../src/lib/agent/catalog";
import { ToolError, clipResult, runToolLoop, type LoopTool, type ToolCallEvent } from "../src/lib/agent/loop";
import {
  DEFAULT_SEARCH_URL,
  buildSearchRequest,
  formatSearchResults,
  parseSearchResults,
} from "../src/lib/agent/search";

// ─── A scripted model and some tools ─────────────────────────────────────────

const call = (name: string, args: Record<string, unknown> = {}, id = `c_${name}`): ToolCall => ({ id, name, arguments: args });

/** A model that answers from a list, and remembers what it was asked. */
function scripted(answers: (ChatResult | ((messages: ChatMessage[]) => ChatResult))[]) {
  const asked: { messages: ChatMessage[]; toolChoice: string; tools: string[]; continuing?: boolean; afterEmpty?: number }[] = [];
  let i = 0;
  return {
    asked,
    chat: async (messages: ChatMessage[], opts: { tools: { name: string }[]; toolChoice: string; continuing?: boolean; afterEmpty?: number }) => {
      asked.push({
        messages: [...messages],
        toolChoice: opts.toolChoice,
        tools: opts.tools.map((t) => t.name),
        ...(opts.continuing ? { continuing: true } : {}),
        ...(opts.afterEmpty ? { afterEmpty: opts.afterEmpty } : {}),
      });
      const next = answers[Math.min(i++, answers.length - 1)]!;
      return typeof next === "function" ? next(messages) : next;
    },
  };
}

function tool(name: string, run: (args: Record<string, unknown>) => Promise<string> | string): LoopTool {
  return {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    run: async (args) => run(args),
  };
}

const BASE: ChatMessage[] = [
  { role: "system", content: "You are an agent." },
  { role: "user", content: "Task: do it" },
];
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// ─── The loop ────────────────────────────────────────────────────────────────

test("a tool whose answers show the same thing as it is now: older answers give way to the newest", async () => {
  // A page in a browser: every answer is the page then. Read again with every step, the earlier ones only cost.
  const view = (n: number) => `Did step ${n}.\n[page]\n${"what the page showed then ".repeat(40)}`;
  const page: LoopTool = {
    definition: { name: "page", description: "page", parameters: { type: "object", properties: {} } },
    run: async (args) => {
      if (args.n === 2) throw new ToolError("That element is not on the page.");
      return view(Number(args.n));
    },
    shorten: (result) => result.split("\n[page]")[0]!,
  };
  const model = scripted([
    { content: "", toolCalls: [call("page", { n: 1 }, "a")] },
    { content: "", toolCalls: [call("page", { n: 2 }, "b")] },
    { content: "", toolCalls: [call("other", {}, "c")] },
    { content: "", toolCalls: [call("page", { n: 4 }, "d")] },
    { content: "Done." },
  ]);
  const events: ToolCallEvent[] = [];
  await runToolLoop({ chat: model.chat, messages: [...BASE], tools: [page, tool("other", () => "something else")], maxSteps: 8, estimateTokens, onToolCall: (e) => events.push(e) });
  const toolMessages = (i: number) => model.asked[i]!.messages.filter((m) => m.role === "tool").map((m) => m.content);
  // After the first answer: it is the newest, whole.
  assert.deepEqual(toolMessages(1), [view(1)]);
  // An answer that says what went wrong shows no page: the one before it stays whole.
  assert.deepEqual(toolMessages(2), [view(1), "That element is not on the page."]);
  // Another tool's answer changes nothing.
  assert.deepEqual(toolMessages(3), [view(1), "That element is not on the page.", "something else"]);
  // The next page: the earlier one keeps what it said had been done, the error and the other tool stay as they were.
  assert.deepEqual(toolMessages(4), ["Did step 1.", "That element is not on the page.", "something else", view(4)]);
  // What is written down of each call is what the model read at the time.
  assert.deepEqual(events.map((e) => e.result), [view(1), "That element is not on the page.", "something else", view(4)]);
});

test("a model that answers at once is asked once, and the conversation is not changed", async () => {
  const model = scripted([{ content: "Done.", usage: { promptTokens: 10, completionTokens: 2 } }]);
  const messages = [...BASE];
  const result = await runToolLoop({ chat: model.chat, messages, tools: [tool("noop", () => "ok")], maxSteps: 5, estimateTokens });
  assert.deepEqual(result, { content: "Done.", steps: 1, toolCalls: 0, promptTokens: 10, completionTokens: 2, stopped: "answer", continued: 0, cut: false, emptied: 0 });
  assert.equal(model.asked[0]!.toolChoice, "auto");
  assert.deepEqual(messages, BASE);
});

test("tool calls are run, their results go back under the call's id, and the model is asked again", async () => {
  const events: ToolCallEvent[] = [];
  const model = scripted([
    { content: "Let me look.", toolCalls: [call("read", { path: "a.txt" }, "c1"), call("list", {}, "c2")], raw: { adapter: "x", content: ["blocks"] } },
    { content: "It says hello." },
  ]);
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [tool("read", (args) => `content of ${String(args.path)}`), tool("list", () => "a.txt")],
    maxSteps: 5,
    estimateTokens,
    onToolCall: (e) => events.push(e),
  });
  assert.equal(result.content, "It says hello.");
  assert.deepEqual([result.steps, result.toolCalls, result.stopped], [2, 2, "answer"]);
  const second = model.asked[1]!.messages;
  assert.deepEqual(second.slice(2), [
    // The turn goes back as it came, with the provider's own form of it.
    { role: "assistant", content: "Let me look.", toolCalls: [call("read", { path: "a.txt" }, "c1"), call("list", {}, "c2")], raw: { adapter: "x", content: ["blocks"] } },
    { role: "tool", toolCallId: "c1", name: "read", content: "content of a.txt", isError: false },
    { role: "tool", toolCallId: "c2", name: "list", content: "a.txt", isError: false },
  ]);
  assert.deepEqual(events.map((e) => [e.step, e.name, e.isError, e.result]), [[1, "read", false, "content of a.txt"], [1, "list", false, "a.txt"]]);
});

test("what goes wrong in a tool is told to the model, and the loop goes on", async () => {
  const model = scripted([
    {
      content: "",
      toolCalls: [
        call("fails", {}, "c1"),
        call("crashes", {}, "c2"),
        call("missing", {}, "c3"),
        { id: "c4", name: "fails", arguments: {}, invalidArguments: "{not json" },
      ],
    },
    { content: "I could not do it." },
  ]);
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [
      tool("fails", () => {
        throw new ToolError("There is no file a.txt.");
      }),
      tool("crashes", () => {
        throw new Error("secret internal detail");
      }),
    ],
    maxSteps: 5,
    estimateTokens,
  });
  assert.equal(result.content, "I could not do it.");
  const results = model.asked[1]!.messages.filter((m) => m.role === "tool");
  assert.deepEqual(results.map((m) => m.isError), [true, true, true, true]);
  assert.equal(results[0]!.content, "There is no file a.txt.");
  // What a crash says is not passed on.
  assert.equal(results[1]!.content, "The tool failed unexpectedly.");
  assert.match(results[2]!.content, /no tool named "missing".*fails, crashes/);
  assert.match(results[3]!.content, /not a JSON object: \{not json/);
});

test("the last step is kept for the answer: the model is told, and gets no tools", async () => {
  const model = scripted([{ content: "", toolCalls: [call("list")] }, { content: "", toolCalls: [call("list", { again: 1 })] }, { content: "What I have so far." }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a.txt")], maxSteps: 3, estimateTokens });
  assert.deepEqual([result.content, result.steps, result.toolCalls, result.stopped], ["What I have so far.", 3, 2, "max_steps"]);
  const last = model.asked[2]!;
  assert.equal(last.toolChoice, "none");
  assert.match(last.messages.at(-1)!.content, /no tool calls left/);
  assert.equal(last.messages.at(-1)!.role, "user");
});

test("a model that still asks for a tool on its last step gets none", async () => {
  const model = scripted([{ content: "", toolCalls: [call("list")] }, { content: "Partial.", toolCalls: [call("list", { n: 2 })] }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a.txt")], maxSteps: 2, estimateTokens });
  assert.deepEqual([result.content, result.steps, result.toolCalls, result.stopped], ["Partial.", 2, 1, "max_steps"]);
});

test("one step means one call without tools", async () => {
  const model = scripted([{ content: "Only answer." }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "x")], maxSteps: 1, estimateTokens });
  assert.deepEqual([result.content, result.steps, result.stopped], ["Only answer.", 1, "answer"]);
  assert.equal(model.asked[0]!.toolChoice, "none");
  // Nothing was added to the conversation before the first call.
  assert.equal(model.asked[0]!.messages.length, BASE.length);
});

test("the same call three times in a row is not run a third time", async () => {
  let runs = 0;
  const model = scripted([{ content: "", toolCalls: [call("list")] }, { content: "", toolCalls: [call("list")] }, { content: "", toolCalls: [call("list")] }, { content: "Stopping." }]);
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [tool("list", () => {
      runs++;
      return "a.txt";
    })],
    maxSteps: 10,
    estimateTokens,
  });
  assert.equal(runs, 2);
  assert.equal(result.content, "Stopping.");
  const results = model.asked[3]!.messages.filter((m) => m.role === "tool");
  assert.deepEqual(results.map((m) => m.isError), [false, false, true]);
  assert.match(results[2]!.content, /three times in a row/);
});

test("a long result is cut, and says by how much", async () => {
  const model = scripted([{ content: "", toolCalls: [call("big")] }, { content: "ok" }]);
  await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("big", () => "x".repeat(500))], maxSteps: 3, maxResultChars: 100, estimateTokens });
  const result = model.asked[1]!.messages.find((m) => m.role === "tool")!.content;
  assert.equal(result, `${"x".repeat(100)}\n[cut: 400 more characters were not shown]`);
  assert.equal(clipResult("short", 100), "short");
});

test("out of tokens: one more call for the answer, without tools", async () => {
  const model = scripted([{ content: "", toolCalls: [call("list")], usage: { promptTokens: 900, completionTokens: 200 } }, { content: "Summary.", usage: { promptTokens: 50, completionTokens: 10 } }]);
  // Whoever runs the loop keeps the balance: here, a thousand tokens.
  let used = 0;
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [tool("list", () => "a")],
    maxSteps: 10,
    estimateTokens,
    onUsage: (prompt, completion) => {
      used += prompt + completion;
    },
    outOfTokens: () => used >= 1000,
  });
  assert.deepEqual([result.content, result.steps, result.stopped, result.promptTokens, result.completionTokens], ["Summary.", 2, "tokens", 950, 210]);
  assert.equal(model.asked[1]!.toolChoice, "none");
  // The last call is counted as well.
  assert.equal(used, 1160);
});

test("with tokens left, the loop goes on to its answer, however many it has used", async () => {
  const big = { promptTokens: 400_000, completionTokens: 100_000 };
  const model = scripted([
    { content: "", toolCalls: [call("list", { n: 1 })], usage: big },
    { content: "", toolCalls: [call("list", { n: 2 })], usage: big },
    { content: "Done.", usage: big },
  ]);
  let asked = 0;
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [tool("list", () => "a")],
    maxSteps: 10,
    estimateTokens,
    outOfTokens: () => {
      asked++;
      return false;
    },
  });
  assert.deepEqual([result.content, result.steps, result.stopped, result.promptTokens + result.completionTokens], ["Done.", 3, "answer", 1_500_000]);
  // Asked after each step that called a tool, and not after the answer.
  assert.equal(asked, 2);
});

test("each answered call says what it used: reported or estimated, and known when a later call fails", async () => {
  const seen: [number, number][] = [];
  let calls = 0;
  const failing = async (): Promise<ChatResult> => {
    calls++;
    if (calls === 1) return { content: "", toolCalls: [call("list", { n: 1 })], usage: { promptTokens: 120, completionTokens: 30 } };
    // No usage from the provider: the loop estimates it.
    if (calls === 2) return { content: "", toolCalls: [call("list", { n: 2 })] };
    throw new Error("The provider is down.");
  };
  await assert.rejects(
    runToolLoop({ chat: failing, messages: BASE, tools: [tool("list", () => "a")], maxSteps: 10, estimateTokens, onUsage: (prompt, completion) => seen.push([prompt, completion]) }),
    /The provider is down/,
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], [120, 30]);
  assert.ok(seen[1]![0] > 0 && seen[1]![1] > 0, JSON.stringify(seen[1]));
  // What the calls said is what the loop returns when it ends in an answer.
  const told: [number, number][] = [];
  const model = scripted([{ content: "", toolCalls: [call("list")], usage: { promptTokens: 7, completionTokens: 3 } }, { content: "ok", usage: { promptTokens: 11, completionTokens: 5 } }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a")], maxSteps: 5, estimateTokens, onUsage: (prompt, completion) => told.push([prompt, completion]) });
  assert.deepEqual(told, [[7, 3], [11, 5]]);
  assert.deepEqual([result.promptTokens, result.completionTokens], [18, 8]);
});

test("a cancelled run stops before the next call, and tools are not run", async () => {
  let cancelled = false;
  let ran = 0;
  const model = scripted([{ content: "", toolCalls: [call("first"), call("second")] }, { content: "never asked" }]);
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [
      tool("first", () => {
        ran++;
        cancelled = true;
        return "done";
      }),
      tool("second", () => {
        ran++;
        return "must not run";
      }),
    ],
    maxSteps: 5,
    estimateTokens,
    isCancelled: () => cancelled,
  });
  assert.deepEqual([result.stopped, result.content, ran, model.asked.length], ["cancelled", "", 1, 1]);
  const before = await runToolLoop({ chat: model.chat, messages: BASE, tools: [], maxSteps: 5, estimateTokens, isCancelled: () => true });
  assert.equal(before.stopped, "cancelled");
});

// ─── Replies that are no answer: cut at the length limit, or empty ───────────

test("an answer that was cut at the length limit goes on, and the pieces are one answer", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("list")] },
    { content: "# PRD\n\nThe shop sells ench", finishReason: "length", usage: { promptTokens: 100, completionTokens: 40 } },
    { content: "antments, and asks to con", finishReason: "length", usage: { promptTokens: 150, completionTokens: 40 } },
    { content: "firm.", finishReason: "stop", usage: { promptTokens: 200, completionTokens: 5 } },
  ]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a.txt")], maxSteps: 5, estimateTokens });
  assert.equal(result.content, "# PRD\n\nThe shop sells enchantments, and asks to confirm.");
  assert.deepEqual([result.stopped, result.continued, result.cut, result.steps, result.toolCalls], ["answer", 2, false, 4, 1]);
  // What each call used is counted, the ones that went on included.
  assert.equal(result.completionTokens >= 85, true);
  // The model is shown what it wrote, and told to go on from there; whoever asks is told that this is the same answer.
  assert.deepEqual([model.asked[1]!.continuing, model.asked[2]!.continuing, model.asked[3]!.continuing], [undefined, true, true]);
  const third = model.asked[2]!.messages;
  assert.deepEqual([third.at(-2)!.role, third.at(-2)!.content], ["assistant", "# PRD\n\nThe shop sells ench"]);
  assert.equal(third.at(-1)!.role, "user");
  assert.match(third.at(-1)!.content, /cut off.*Continue it from exactly where it stopped/);
  assert.equal(model.asked[3]!.messages.at(-2)!.content, "antments, and asks to con");
});

test("going on does not use up the steps: a long answer at the last step is still whole", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("list")] },
    { content: "part one, ", finishReason: "length" },
    { content: "part two, ", finishReason: "length" },
    { content: "part three, ", finishReason: "length" },
    { content: "the end.", finishReason: "stop" },
  ]);
  // Two steps: one for the tool, one for the answer.
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a.txt")], maxSteps: 2, estimateTokens });
  assert.deepEqual([result.content, result.stopped, result.continued, result.cut], ["part one, part two, part three, the end.", "max_steps", 3, false]);
  // The model was told once that it has no calls left, not with every part.
  const told = model.asked[4]!.messages.filter((m) => m.role === "user" && /no tool calls left/.test(m.content));
  assert.equal(told.length, 1);
  assert.deepEqual(model.asked.slice(1).map((a) => a.toolChoice), ["none", "none", "none", "none"]);
});

test("it goes on only so often: an answer that is still cut says so", async () => {
  const model = scripted([{ content: "again ", finishReason: "max_tokens" }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [], maxSteps: 3, maxContinuations: 2, estimateTokens });
  assert.deepEqual([result.content, result.continued, result.cut, result.stopped, model.asked.length], ["again again again ", 2, true, "answer", 3]);
});

test("going on that fails keeps what was written, as an answer that is cut", async () => {
  let calls = 0;
  const failing = async (): Promise<ChatResult> => {
    calls++;
    if (calls === 1) return { content: "The first half of the document", finishReason: "length" };
    throw new Error("The provider is down.");
  };
  const result = await runToolLoop({ chat: failing, messages: BASE, tools: [], maxSteps: 3, estimateTokens });
  assert.deepEqual([result.content, result.cut, result.stopped], ["The first half of the document", true, "answer"]);
  // Asked to go on, it wrote nothing: the same.
  const silent = scripted([{ content: "Half", finishReason: "length" }, { content: "", finishReason: "stop" }]);
  const still = await runToolLoop({ chat: silent.chat, messages: BASE, tools: [], maxSteps: 3, estimateTokens });
  assert.deepEqual([still.content, still.cut, still.continued], ["Half", true, 1]);
});

test("an account without tokens left does not go on: the answer stays cut", async () => {
  const model = scripted([{ content: "Half", finishReason: "length" }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [], maxSteps: 3, estimateTokens, outOfTokens: () => true });
  assert.deepEqual([result.content, result.cut, result.continued, model.asked.length], ["Half", true, 0, 1]);
});

test("a reply with nothing in it after the tools were used is asked again, with a word to go on", async () => {
  // What a weak model does in the middle of its work: no text, no call.
  const model = scripted([
    { content: "", toolCalls: [call("write", { path: "plugin.yml" })] },
    { content: "" },
    { content: "", toolCalls: [call("write", { path: "Shop.java" })] },
    { content: "Both files are written." },
  ]);
  const written: string[] = [];
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [tool("write", (args) => {
      written.push(String(args.path));
      return "saved";
    })],
    maxSteps: 8,
    estimateTokens,
  });
  assert.deepEqual(written, ["plugin.yml", "Shop.java"]);
  assert.deepEqual([result.content, result.stopped, result.emptied, result.toolCalls], ["Both files are written.", "answer", 1, 2]);
  // The call after the empty reply says so, and the model is told to go on.
  assert.deepEqual([model.asked[1]!.afterEmpty, model.asked[2]!.afterEmpty, model.asked[3]!.afterEmpty], [undefined, 1, undefined]);
  const third = model.asked[2]!.messages;
  assert.equal(third.at(-1)!.role, "user");
  assert.match(third.at(-1)!.content, /last reply was empty.*make the next tool call/);
  // No empty turn of the assistant is put into the conversation.
  assert.equal(third.some((m) => m.role === "assistant" && !m.content && !m.toolCalls?.length), false);
  assert.equal(model.asked[2]!.toolChoice, "auto");
});

test("an empty first reply is asked for again as it stands, and only so often", async () => {
  const model = scripted([{ content: "" }, { content: "  \n" }, { content: "Here it is." }]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a")], maxSteps: 8, estimateTokens });
  assert.deepEqual([result.content, result.emptied, result.steps], ["Here it is.", 2, 3]);
  // Nothing is added before a tool was used: two messages of the person in a row are not what every model takes.
  assert.equal(model.asked[2]!.messages.length, BASE.length);
  assert.deepEqual(model.asked.map((a) => a.afterEmpty), [undefined, 1, 2]);

  // A model that never writes anything: the loop ends, with nothing.
  const mute = scripted([{ content: "" }]);
  const nothing = await runToolLoop({ chat: mute.chat, messages: BASE, tools: [], maxSteps: 8, estimateTokens });
  assert.deepEqual([nothing.content, nothing.stopped, nothing.emptied, mute.asked.length], ["", "answer", 2, 3]);
  // As often as it is set to: not at all.
  const once = scripted([{ content: "" }]);
  await runToolLoop({ chat: once.chat, messages: BASE, tools: [], maxSteps: 8, maxEmptyRetries: 0, estimateTokens });
  assert.equal(once.asked.length, 1);
});

test("empty replies in a row are counted anew after the work went on", async () => {
  const model = scripted([
    { content: "", toolCalls: [call("list", { n: 1 })] },
    { content: "" },
    { content: "" },
    { content: "", toolCalls: [call("list", { n: 2 })] },
    { content: "" },
    { content: "Done." },
  ]);
  const result = await runToolLoop({ chat: model.chat, messages: BASE, tools: [tool("list", () => "a")], maxSteps: 12, estimateTokens });
  assert.deepEqual([result.content, result.emptied, result.toolCalls], ["Done.", 3, 2]);
  assert.deepEqual(model.asked.map((a) => a.afterEmpty), [undefined, undefined, 1, 2, undefined, 1]);
});

test("a call that was cut at the length limit is not run, and the model is told to write less at once", async () => {
  let runs = 0;
  const model = scripted([
    { content: "", finishReason: "length", toolCalls: [{ id: "c1", name: "write", arguments: {}, invalidArguments: '{"path":"Shop.java","content":"public class Shop {' }] },
    { content: "", toolCalls: [call("write", { path: "Shop.java", content: "part 1" })] },
    { content: "Written in parts." },
  ]);
  const result = await runToolLoop({
    chat: model.chat,
    messages: BASE,
    tools: [tool("write", () => {
      runs++;
      return "saved";
    })],
    maxSteps: 6,
    estimateTokens,
  });
  assert.equal(runs, 1);
  assert.equal(result.content, "Written in parts.");
  const told = model.asked[1]!.messages.find((m) => m.role === "tool")!;
  assert.equal(told.isError, true);
  assert.match(told.content, /cut off at the length limit.*nothing was run.*write it in parts/);
  // Arguments that are wrong for another reason are still shown as they came.
  const other = scripted([{ content: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "write", arguments: {}, invalidArguments: "{not json" }] }, { content: "ok" }]);
  await runToolLoop({ chat: other.chat, messages: BASE, tools: [tool("write", () => "saved")], maxSteps: 4, estimateTokens });
  assert.match(other.asked[1]!.messages.find((m) => m.role === "tool")!.content, /not a JSON object: \{not json/);
});

test("tokens are estimated when the provider reports none", async () => {
  const model = scripted([{ content: "12345678" }]);
  const result = await runToolLoop({ chat: model.chat, messages: [{ role: "user", content: "1234" }], tools: [], maxSteps: 2, estimateTokens });
  assert.equal(result.promptTokens, 1);
  assert.ok(result.completionTokens >= 2);
  // Without tools there is nothing to choose.
  assert.equal(model.asked[0]!.toolChoice, "none");
});

// ─── The catalog ─────────────────────────────────────────────────────────────

test("an agent's stored tools are read leniently", () => {
  assert.deepEqual(parseToolNames('["read_file","write_file","read_file","format_disk",7]'), ["read_file", "write_file"]);
  assert.deepEqual(parseToolNames("not json"), []);
  assert.deepEqual(parseToolNames('{"a":1}'), []);
  assert.deepEqual(parseToolNames(null), []);
  assert.equal(isToolName("run_command"), true);
  assert.equal(isToolName("search_knowledge"), false); // comes with a collection, not by itself
  assert.deepEqual(TOOL_CATALOG.map((t) => t.name), [...TOOL_NAMES]);
  assert.deepEqual(TOOL_CATALOG.filter((t) => t.needs).map((t) => [t.name, t.needs]), [["run_command", "sandbox"], ["web_search", "search"], ["use_browser", "browser"]]);
  assert.ok(DEFAULT_MAX_STEPS >= 2);
});

// ─── Web search services ─────────────────────────────────────────────────────

test("each search service gets its own request", () => {
  assert.deepEqual(buildSearchRequest("brave", DEFAULT_SEARCH_URL.brave!, "KEY", "light house", 3), {
    url: "https://api.search.brave.com/res/v1/web/search?q=light+house&count=3",
    method: "GET",
    headers: { accept: "application/json", "x-subscription-token": "KEY" },
  });
  assert.deepEqual(buildSearchRequest("tavily", DEFAULT_SEARCH_URL.tavily!, "tvly-KEY", "light house", 99), {
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tvly-KEY" },
    // No more results than the limit.
    body: JSON.stringify({ query: "light house", max_results: 10 }),
  });
  const searx = buildSearchRequest("searxng", "https://search.example.com/", undefined, "a&b", 5);
  assert.equal(searx.url, "https://search.example.com/search?q=a%26b&format=json");
  assert.deepEqual(searx.headers, { accept: "application/json" });
  assert.equal(buildSearchRequest("searxng", "https://search.example.com/search", undefined, "x", 5).url, "https://search.example.com/search?q=x&format=json");
  assert.equal(DEFAULT_SEARCH_URL.searxng, null);
});

test("results are read into one shape; markup, repeats and links that are not web links are dropped", () => {
  const brave = parseSearchResults(
    "brave",
    {
      web: {
        results: [
          { title: "The <strong>lighthouse</strong>", url: "https://a.example/1", description: "About   <b>lights</b>." },
          { title: "Script", url: "javascript:alert(1)", description: "x" },
          { title: "Again", url: "https://a.example/1", description: "duplicate" },
          { title: "", url: "https://a.example/2", description: "" },
          { title: "Third", url: "https://a.example/3", description: "x" },
        ],
      },
    },
    2,
  );
  assert.deepEqual(brave, [
    { title: "The lighthouse", url: "https://a.example/1", snippet: "About lights." },
    { title: "https://a.example/2", url: "https://a.example/2", snippet: "" },
  ]);
  const tavily = parseSearchResults("tavily", { results: [{ title: "T", url: "https://t.example", content: "Body" }] }, 5);
  assert.deepEqual(tavily, [{ title: "T", url: "https://t.example", snippet: "Body" }]);
  assert.deepEqual(parseSearchResults("searxng", { results: "nope" }, 5), []);
  assert.deepEqual(parseSearchResults("brave", null, 5), []);
  const long = parseSearchResults("tavily", { results: [{ title: "T", url: "https://t.example", content: "x".repeat(900) }] }, 1);
  assert.equal(long[0]!.snippet.length, 500);
});

test("results are written as a numbered list for the model", () => {
  assert.equal(formatSearchResults("q", []), 'No results for "q".');
  assert.equal(
    formatSearchResults("q", [
      { title: "One", url: "https://one.example", snippet: "First." },
      { title: "Two", url: "https://two.example", snippet: "" },
    ]),
    "1. One\n   https://one.example\n   First.\n\n2. Two\n   https://two.example",
  );
});
