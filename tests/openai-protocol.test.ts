import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChatBody,
  buildEmbeddingsBody,
  buildSpeechBody,
  createChatStream,
  parseChatResponse,
  parseEmbeddingsResponse,
  parseModelList,
  parseToolArguments,
  toOpenAiMessages,
} from "../src/lib/adapters/openai-protocol";
import type { ChatMessage } from "../src/lib/adapters/types";
import { AppError } from "../src/lib/errors";

const TOOL = {
  name: "write_file",
  description: "Write a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

// ─── Requests ────────────────────────────────────────────────────────────────

test("a plain request has no tool fields, and asks for usage only when streaming", () => {
  const body = buildChatBody({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.2 }, { stream: false });
  assert.deepEqual(body, { model: "m", messages: [{ role: "user", content: "hi" }], stream: false, temperature: 0.2 });
  const streamed = buildChatBody({ model: "m", messages: [{ role: "user", content: "hi" }] }, { stream: true });
  assert.deepEqual(streamed.stream_options, { include_usage: true });
  assert.equal("temperature" in streamed, false);
});

test("tools are sent as functions, with the choice, and a token limit when one is set", () => {
  const body = buildChatBody(
    { model: "m", messages: [{ role: "user", content: "hi" }], tools: [TOOL], toolChoice: "required", maxTokens: 500 },
    { stream: false },
  );
  assert.deepEqual(body.tools, [{ type: "function", function: TOOL }]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.max_tokens, 500);
  // A choice without tools would be an error at the provider.
  const none = buildChatBody({ model: "m", messages: [], tools: [], toolChoice: "auto" }, { stream: false });
  assert.equal("tools" in none, false);
  assert.equal("tool_choice" in none, false);
});

test("a tool turn and its results are written the way chat completions expects them", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Save it." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_1", name: "write_file", arguments: { path: "a.txt" } },
        { id: "call_2", name: "read_file", arguments: {}, invalidArguments: "not json" },
      ],
      // Another provider's native form of the turn is not sent here.
      raw: { adapter: "anthropic", content: [{ type: "thinking" }] },
    },
    { role: "tool", toolCallId: "call_1", name: "write_file", content: "Saved.", isError: false },
    { role: "tool", toolCallId: "call_2", name: "read_file", content: "The arguments were not JSON.", isError: true },
  ];
  assert.deepEqual(toOpenAiMessages(messages), [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Save it." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt"}' } },
        // What the model sent is echoed as it was, so it sees its own mistake.
        { id: "call_2", type: "function", function: { name: "read_file", arguments: "not json" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Saved." },
    { role: "tool", tool_call_id: "call_2", content: "The arguments were not JSON." },
  ]);
});

// ─── Responses ───────────────────────────────────────────────────────────────

test("tool arguments: a JSON object, the object itself, nothing, or text that is kept as it was", () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { arguments: { a: 1 } });
  assert.deepEqual(parseToolArguments({ a: 1 }), { arguments: { a: 1 } });
  assert.deepEqual(parseToolArguments(""), { arguments: {} });
  assert.deepEqual(parseToolArguments(undefined), { arguments: {} });
  assert.deepEqual(parseToolArguments("null"), { arguments: {} });
  assert.deepEqual(parseToolArguments('{"a":'), { arguments: {}, invalidArguments: '{"a":' });
  assert.deepEqual(parseToolArguments("[1,2]"), { arguments: {}, invalidArguments: "[1,2]" });
  assert.deepEqual(parseToolArguments(7), { arguments: {}, invalidArguments: "7" });
});

test("a response with tool calls yields them, with ids made up where the provider sent none", () => {
  const result = parseChatResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "write_file", arguments: '{"path":"a"}' } },
            { type: "function", function: { name: "list_files", arguments: "" } },
            { id: "x", type: "function", function: { arguments: "{}" } }, // no name: dropped
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  });
  assert.equal(result.content, "");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.toolCalls, [
    { id: "call_a", name: "write_file", arguments: { path: "a" } },
    { id: "call_1", name: "list_files", arguments: {} },
  ]);
  assert.deepEqual(result.usage, { promptTokens: 5, completionTokens: 7, totalTokens: 12 });
});

test("content given as parts is joined; a response without usage reports none", () => {
  const result = parseChatResponse({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "image_url" }, { text: "b" }] } }] });
  assert.equal(result.content, "ab");
  assert.equal(result.usage, undefined);
  assert.equal(result.toolCalls, undefined);
});

test("a 200 answer that is an error object is raised, without a key it may repeat", () => {
  assert.throws(
    () => parseChatResponse({ error: { message: "Invalid key sk-abcdefghijklmnop123456" } }),
    (err: unknown) => err instanceof AppError && err.status === 502 && /Provider error: Invalid key \[redacted-key\]/.test(err.message),
  );
  assert.throws(() => parseChatResponse({}), /without choices/);
});

// ─── Streaming ───────────────────────────────────────────────────────────────

test("a stream yields its text as it arrives, then usage and the stop reason", () => {
  const seen: string[] = [];
  const stream = createChatStream((t) => seen.push(t));
  stream.handle(JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] }));
  stream.handle(JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }));
  stream.handle(": keep-alive");
  stream.handle(JSON.stringify({ choices: [{ delta: { content: "lo" } }] }));
  stream.handle(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
  stream.handle(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  stream.handle("[DONE]");
  assert.deepEqual(seen, ["Hel", "lo"]);
  assert.deepEqual(stream.result(), {
    content: "Hello",
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    finishReason: "stop",
  });
});

test("tool calls that arrive in pieces are put together, each under its index", () => {
  const stream = createChatStream(() => undefined);
  const piece = (tool_calls: unknown[]) => stream.handle(JSON.stringify({ choices: [{ delta: { tool_calls } }] }));
  piece([{ index: 0, id: "call_a", type: "function", function: { name: "write_file", arguments: '{"pa' } }]);
  piece([{ index: 1, id: "call_b", type: "function", function: { name: "list_files", arguments: "" } }]);
  piece([{ index: 0, function: { arguments: 'th":"a.txt"}' } }]);
  stream.handle(JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
  const result = stream.result();
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.toolCalls, [
    { id: "call_a", name: "write_file", arguments: { path: "a.txt" } },
    { id: "call_b", name: "list_files", arguments: {} },
  ]);
});

test("an error object in the stream is raised", () => {
  const stream = createChatStream(() => undefined);
  assert.throws(
    () => stream.handle(JSON.stringify({ error: { message: "overloaded" } })),
    (err: unknown) => err instanceof AppError && /Provider stream error: overloaded/.test(err.message),
  );
});

// ─── Models, embeddings, speech ──────────────────────────────────────────────

test("a plain model list is ids; an OpenRouter-style one also says what each model is for", () => {
  assert.deepEqual(parseModelList({ data: [{ id: "gpt-x" }, { id: "" }, { nope: 1 }] }), [{ id: "gpt-x" }]);
  const [chat, image, video, speech] = parseModelList({
    data: [
      {
        id: "acme/chat",
        name: "Acme Chat",
        context_length: 128000,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "response_format", "reasoning"],
      },
      { id: "acme/image", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
      { id: "acme/video", architecture: { output_modalities: ["video"] } },
      { id: "acme/tts", architecture: { output_modalities: ["audio"] } },
    ],
  });
  assert.deepEqual(chat, {
    id: "acme/chat",
    displayName: "Acme Chat",
    contextWindow: 128000,
    capabilities: ["text", "vision", "tool_calling", "reasoning", "structured_output"],
  });
  assert.deepEqual(image?.capabilities, ["image_generation"]);
  assert.deepEqual(video?.capabilities, ["video_generation"]);
  assert.deepEqual(speech?.capabilities, ["speech_generation"]);
});

test("embeddings: floats are asked for, and each vector is put where its index says", () => {
  assert.deepEqual(buildEmbeddingsBody({ model: "e", input: ["a", "b"] }), { model: "e", input: ["a", "b"], encoding_format: "float" });
  assert.equal(buildEmbeddingsBody({ model: "e", input: ["a"], dimensions: 256 }).dimensions, 256);
  const result = parseEmbeddingsResponse(
    { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 9 } },
    2,
  );
  assert.deepEqual(result, { vectors: [[1, 2], [3, 4]], promptTokens: 9 });
  assert.throws(() => parseEmbeddingsResponse({ data: [{ index: 0, embedding: [1] }] }, 2), /fewer embeddings than texts/);
  assert.throws(() => parseEmbeddingsResponse({ data: [{ index: 0, embedding: ["a"] }] }, 1), /fewer embeddings/);
  assert.throws(() => parseEmbeddingsResponse({ error: { message: "no such model" } }, 1), /Provider error: no such model/);
});

test("speech: a default voice and format, speed only when it is not normal", () => {
  assert.deepEqual(buildSpeechBody({ model: "tts-1", input: "Hi" }), { model: "tts-1", input: "Hi", voice: "alloy", response_format: "mp3" });
  assert.deepEqual(buildSpeechBody({ model: "tts-1", input: "Hi", voice: " nova ", format: "wav", speed: 1.5, instructions: " calm " }), {
    model: "tts-1",
    input: "Hi",
    voice: "nova",
    response_format: "wav",
    speed: 1.5,
    instructions: "calm",
  });
  assert.equal("speed" in buildSpeechBody({ model: "m", input: "x", speed: 1 }), false);
});

test("a model list that gives prices: what is given away is told from what is billed", () => {
  const listed = parseModelList({
    data: [
      { id: "lab/free-one:free", pricing: { prompt: "0", completion: "0" } },
      { id: "lab/paid-one", pricing: { prompt: "0.00000015", completion: "0.0000006", request: "0", image: "0" } },
      { id: "lab/per-request", pricing: { prompt: "0", completion: "0", request: "0.01" } },
      { id: "lab/in-numbers", pricing: { prompt: 0.000002, completion: 0.00001 } },
      { id: "lab/no-prices" },
      { id: "lab/half-a-price", pricing: { prompt: "0" } },
      { id: "lab/not-a-price", pricing: { prompt: "free", completion: "-1" } },
    ],
  });
  const of = (id: string) => listed.find((m) => m.id === id)!;
  assert.deepEqual(
    [of("lab/free-one:free").billed, of("lab/free-one:free").inputPricePerMTok, of("lab/free-one:free").outputPricePerMTok],
    [false, 0, 0],
  );
  assert.deepEqual(
    [of("lab/paid-one").billed, of("lab/paid-one").inputPricePerMTok, of("lab/paid-one").outputPricePerMTok],
    [true, 0.15, 0.6],
  );
  assert.equal(of("lab/per-request").billed, true, "a price for each request is a price");
  assert.deepEqual([of("lab/in-numbers").billed, of("lab/in-numbers").inputPricePerMTok, of("lab/in-numbers").outputPricePerMTok], [true, 2, 10]);
  for (const id of ["lab/no-prices", "lab/half-a-price", "lab/not-a-price"]) {
    assert.equal(of(id).billed, undefined, `${id}: nothing is said of what is not known`);
    assert.equal(of(id).inputPricePerMTok, undefined, id);
  }
});

test("a model list in a gateway's own words: its word on what is free goes before a sum", () => {
  const listed = parseModelList({
    data: [
      // A router whose price depends on the model it picks.
      { id: "gate/auto", pricing: { prompt: "-1", completion: "-1", request: "0" }, isFree: false },
      { id: "gate/auto-free", pricing: { prompt: "0", completion: "0" }, isFree: true },
      { id: "gate/priced-but-free", pricing: { prompt: "0.000001", completion: "0.000002" }, isFree: true },
      { id: "gate/variable", pricing: { prompt: "-1", completion: "-1" } },
      // Per million tokens, as numbers; "usage_based_only" for what no free allowance covers.
      { id: "other/turbo", pricing: { input: 0.02, output: 0.04, unit: "1M tokens" }, usage_based_only: false },
      { id: "other/pro", pricing: { input: 3, output: 15, unit: "1M tokens" }, usage_based_only: true },
      { id: "other/plain", pricing: { input: 0.5, output: 1.2 } },
      { id: "other/voice", pricing: { price: 0.00002, unit: "second" }, usage_based_only: true },
    ],
  });
  const of = (id: string) => listed.find((m) => m.id === id)!;
  assert.deepEqual(
    ["gate/auto", "gate/auto-free", "gate/priced-but-free", "gate/variable", "other/turbo", "other/pro", "other/plain", "other/voice"].map((id) => of(id).billed),
    [true, false, false, true, false, true, true, true],
  );
  assert.equal(of("gate/auto").inputPricePerMTok, undefined, "a price that depends on the model picked is no price");
  assert.deepEqual([of("gate/priced-but-free").inputPricePerMTok, of("gate/priced-but-free").outputPricePerMTok], [1, 2]);
  assert.deepEqual([of("other/turbo").inputPricePerMTok, of("other/turbo").outputPricePerMTok], [0.02, 0.04]);
  assert.deepEqual([of("other/pro").inputPricePerMTok, of("other/pro").outputPricePerMTok], [3, 15]);
});
