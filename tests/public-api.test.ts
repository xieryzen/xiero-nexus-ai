import assert from "node:assert/strict";
import { test } from "node:test";
import { apiImageSchema, apiSpeechSchema, apiVideoSchema, parseApiBody } from "../src/lib/public-api/media-requests";
import {
  RequestError,
  findModel,
  finishReasonOf,
  formatChatChunk,
  formatChatCompletion,
  formatEmbeddings,
  formatUsageChunk,
  parseChatCompletionRequest,
  parseEmbeddingsRequest,
  publicModelNames,
  vectorToBase64,
} from "../src/lib/public-api/openai-format";

function requestError(message: RegExp, param?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof RequestError, `expected a RequestError, got ${String(err)}`);
    assert.match(err.message, message);
    if (param !== undefined) assert.equal(err.param, param);
    return true;
  };
}

// ─── Chat requests ───────────────────────────────────────────────────────────

test("a chat request in the OpenAI format is read into the gateway's own", () => {
  const parsed = parseChatCompletionRequest({
    model: " chat-mini ",
    messages: [
      { role: "developer", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Line one" }, { type: "text", text: "line two" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "call_1", name: "write_file", content: "Saved." },
    ],
    temperature: 0.2,
    max_completion_tokens: 500.9,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(parsed, {
    model: "chat-mini",
    messages: [
      // "developer" is the newer name of the system role.
      { role: "system", content: "Be brief." },
      { role: "user", content: "Line one\nline two" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "write_file", arguments: { path: "a" } }] },
      { role: "tool", content: "Saved.", toolCallId: "call_1", name: "write_file" },
    ],
    temperature: 0.2,
    maxTokens: 500,
    tools: undefined,
    toolChoice: undefined,
    stream: true,
    includeUsage: true,
  });
});

test("tools and the tool choice are read; a choice without tools is ignored", () => {
  const tool = { type: "function", function: { name: "list_files", description: "List", parameters: { type: "object", properties: {} } } };
  const parsed = parseChatCompletionRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [tool, { type: "function", function: { name: "bare" } }], tool_choice: "required" });
  assert.deepEqual(parsed.tools, [
    { name: "list_files", description: "List", parameters: { type: "object", properties: {} } },
    { name: "bare", description: "", parameters: { type: "object", properties: {} } },
  ]);
  assert.equal(parsed.toolChoice, "required");
  // Naming one function is the same as requiring some tool: no provider-neutral way to force one.
  assert.equal(parseChatCompletionRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [tool], tool_choice: { type: "function", function: { name: "list_files" } } }).toolChoice, "required");
  const none = parseChatCompletionRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tool_choice: "auto", tools: [] });
  assert.equal(none.tools, undefined);
  assert.equal(none.toolChoice, undefined);
  assert.equal(none.stream, false);
  assert.equal(none.includeUsage, false);
});

test("a tool call's arguments that are not a JSON object are kept as the model wrote them", () => {
  const parsed = parseChatCompletionRequest({
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{oops" } }, { id: "d", type: "function", function: { name: "g", arguments: { a: 1 } } }] },
    ],
  });
  assert.deepEqual(parsed.messages[1], {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "c", name: "f", arguments: {}, invalidArguments: "{oops" },
      { id: "d", name: "g", arguments: { a: 1 } },
    ],
  });
});

test("a bad chat request names what is wrong, and where", () => {
  const user = [{ role: "user", content: "hi" }];
  assert.throws(() => parseChatCompletionRequest(null), requestError(/JSON object/));
  assert.throws(() => parseChatCompletionRequest({ messages: user }), requestError(/model is required/, "model"));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: [] }), requestError(/non-empty array/, "messages"));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: user, n: 2 }), requestError(/n must be 1/, "n"));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: [{ content: "x" }] }), requestError(/needs a role/, "messages[0]"));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: [{ role: "robot", content: "x" }] }), requestError(/role "robot"/, "messages[0]"));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: [{ role: "tool", content: "x" }] }), requestError(/tool_call_id/, "messages[0]"));
  assert.throws(
    () => parseChatCompletionRequest({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] }),
    requestError(/"image_url" are not supported/, "messages[0]"),
  );
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: [{ role: "user", content: 7 }] }), requestError(/string or an array/));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: user, temperature: 3 }), requestError(/temperature/, "temperature"));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: user, max_tokens: 0 }), requestError(/max_tokens/));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: user, tools: "x" }), requestError(/tools must be an array/));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: user, tools: [{ type: "function", function: { name: "bad name!" } }] }), requestError(/not a valid function name/));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: user, tools: [{ type: "function", function: { name: "f" } }], tool_choice: "sometimes" }), requestError(/tool_choice/));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: Array.from({ length: 401 }, () => user[0]) }), requestError(/at most 400/));
  assert.throws(() => parseChatCompletionRequest({ model: "m", messages: [{ role: "user", content: "x".repeat(400_001) }] }), requestError(/longer than/));
});

// ─── Chat responses ──────────────────────────────────────────────────────────

test("an answer is written the way OpenAI clients read it", () => {
  const plain = formatChatCompletion({ id: "chatcmpl-1", created: 100, model: "chat-mini", result: { content: "Hi", finishReason: "stop" }, usage: { promptTokens: 3, completionTokens: 1 } });
  assert.deepEqual(plain, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 100,
    model: "chat-mini",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
  const called = formatChatCompletion({
    id: "x",
    created: 1,
    model: "m",
    result: { content: "", toolCalls: [{ id: "c1", name: "f", arguments: { a: 1 } }, { id: "c2", name: "g", arguments: {}, invalidArguments: "{oops" }] },
    usage: { promptTokens: 0, completionTokens: 0 },
  });
  assert.deepEqual(called.choices[0], {
    index: 0,
    message: {
      role: "assistant",
      // No text with tool calls is null, as clients expect.
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        { id: "c2", type: "function", function: { name: "g", arguments: "{oops" } },
      ],
    },
    finish_reason: "tool_calls",
  });
});

test("why a provider stopped is told in OpenAI's words", () => {
  assert.equal(finishReasonOf({ finishReason: "stop" }), "stop");
  assert.equal(finishReasonOf({ finishReason: "end_turn" }), "stop");
  assert.equal(finishReasonOf({ finishReason: "STOP" }), "stop");
  assert.equal(finishReasonOf({ finishReason: "max_tokens" }), "length");
  assert.equal(finishReasonOf({ finishReason: "length" }), "length");
  assert.equal(finishReasonOf({ finishReason: "SAFETY" }), "content_filter");
  assert.equal(finishReasonOf({ finishReason: undefined }), "stop");
  assert.equal(finishReasonOf({ finishReason: "stop", toolCalls: [{ id: "c", name: "f", arguments: {} }] }), "tool_calls");
});

test("the pieces of a streamed answer", () => {
  const base = { id: "x", created: 1, model: "m" };
  assert.deepEqual(formatChatChunk({ ...base, delta: { role: "assistant", content: "" } }).choices, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
  assert.deepEqual(formatChatChunk({ ...base, delta: { content: "Hi" } }).choices[0]!.delta, { content: "Hi" });
  assert.deepEqual(formatChatChunk({ ...base, delta: { toolCalls: [{ id: "c1", name: "f", arguments: {} }] } }).choices[0]!.delta, {
    tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
  });
  assert.deepEqual(formatChatChunk({ ...base, delta: {}, finishReason: "stop" }).choices[0], { index: 0, delta: {}, finish_reason: "stop" });
  assert.deepEqual(formatUsageChunk({ ...base, usage: { promptTokens: 2, completionTokens: 3 } }), {
    id: "x",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
});

// ─── Embeddings ──────────────────────────────────────────────────────────────

test("an embeddings request takes one text or a list of texts", () => {
  assert.deepEqual(parseEmbeddingsRequest({ model: "e", input: "one" }), { model: "e", input: ["one"], dimensions: undefined, base64: false });
  assert.deepEqual(parseEmbeddingsRequest({ model: "e", input: ["a", "b"], dimensions: 256, encoding_format: "base64" }), { model: "e", input: ["a", "b"], dimensions: 256, base64: true });
  assert.throws(() => parseEmbeddingsRequest({ input: "x" }), requestError(/model is required/, "model"));
  assert.throws(() => parseEmbeddingsRequest({ model: "e", input: [] }), requestError(/non-empty/, "input"));
  assert.throws(() => parseEmbeddingsRequest({ model: "e", input: [[1, 2, 3]] }), requestError(/arrays of tokens are not supported/));
  assert.throws(() => parseEmbeddingsRequest({ model: "e", input: ["ok", ""] }), requestError(/input\[1\] is empty/));
  assert.throws(() => parseEmbeddingsRequest({ model: "e", input: Array.from({ length: 257 }, () => "x") }), requestError(/At most 256/));
  assert.throws(() => parseEmbeddingsRequest({ model: "e", input: "x", dimensions: 1.5 }), requestError(/dimensions/, "dimensions"));
  assert.throws(() => parseEmbeddingsRequest({ model: "e", input: "x", encoding_format: "hex" }), requestError(/encoding_format/));
});

test("vectors are sent as numbers, or as base64 of 32-bit floats", () => {
  const out = formatEmbeddings({ model: "e", vectors: [[1, 2], [3, 4]], promptTokens: 7, base64: false });
  assert.deepEqual(out, {
    object: "list",
    data: [
      { object: "embedding", index: 0, embedding: [1, 2] },
      { object: "embedding", index: 1, embedding: [3, 4] },
    ],
    model: "e",
    usage: { prompt_tokens: 7, total_tokens: 7 },
  });
  const encoded = vectorToBase64([0.5, -1.25, 3]);
  const floats = new Float32Array(Buffer.from(encoded, "base64").buffer.slice(0, 12));
  assert.deepEqual([...new Float32Array(new Uint8Array(Buffer.from(encoded, "base64")).buffer)], [0.5, -1.25, 3]);
  assert.equal(floats.length, 3);
  assert.equal(typeof formatEmbeddings({ model: "e", vectors: [[1]], promptTokens: 1, base64: true }).data[0]!.embedding, "string");
});

// ─── Model names ─────────────────────────────────────────────────────────────

const MODELS = [
  { rowId: "r1", modelId: "chat-mini", providerName: "Acme" },
  { rowId: "r2", modelId: "img-ok", providerName: "Acme" },
  { rowId: "r3", modelId: "img-ok", providerName: "Other" },
  { rowId: "r4", modelId: "GPT-Big", providerName: "Other" },
];

test("a model is listed under its own id, or with its provider when two have the same", () => {
  assert.deepEqual([...publicModelNames(MODELS)], [["r1", "chat-mini"], ["r2", "Acme/img-ok"], ["r3", "Other/img-ok"], ["r4", "GPT-Big"]]);
});

test("a request can name a model by its listed name, its row id, or its own id when that is unambiguous", () => {
  assert.equal(findModel(MODELS, "chat-mini"), "r1");
  assert.equal(findModel(MODELS, " chat-mini "), "r1");
  assert.equal(findModel(MODELS, "Other/img-ok"), "r3");
  assert.equal(findModel(MODELS, "r2"), "r2");
  assert.equal(findModel(MODELS, "img-ok"), "ambiguous");
  assert.equal(findModel(MODELS, "gpt-big"), "r4");
  assert.equal(findModel(MODELS, "nope"), null);
  assert.equal(findModel([], "chat-mini"), null);
});

// ─── Media requests ──────────────────────────────────────────────────────────

test("media requests take the names OpenAI clients send, and the app's own limits", () => {
  assert.deepEqual(parseApiBody(apiImageSchema, { model: "img", prompt: " a lamp ", n: 2, aspect_ratio: "9:16", response_format: "b64_json" }), {
    model: "img",
    prompt: "a lamp",
    n: 2,
    aspect_ratio: "9:16",
    response_format: "b64_json",
  });
  assert.deepEqual(parseApiBody(apiSpeechSchema, { model: "tts", input: "Hello", voice: "alloy", response_format: "wav", speed: 1.5 }), { model: "tts", input: "Hello", voice: "alloy", response_format: "wav", speed: 1.5 });
  // OpenAI sends the length as a string of seconds; other video APIs as a number called duration.
  assert.equal(parseApiBody(apiVideoSchema, { model: "vid", prompt: "waves", seconds: "8" }).seconds, 8);
  assert.equal(parseApiBody(apiVideoSchema, { model: "vid", prompt: "waves", duration: 6 }).duration, 6);

  assert.throws(() => parseApiBody(apiImageSchema, { prompt: "x" }), requestError(/model/, "model"));
  assert.throws(() => parseApiBody(apiImageSchema, { model: "m", prompt: "x", n: 9 }), requestError(/n:/, "n"));
  assert.throws(() => parseApiBody(apiImageSchema, { model: "m", prompt: "x", size: "huge" }), requestError(/size: use WIDTHxHEIGHT/, "size"));
  assert.throws(() => parseApiBody(apiSpeechSchema, { model: "m", input: "x".repeat(4097) }), requestError(/input/, "input"));
  assert.throws(() => parseApiBody(apiSpeechSchema, { model: "m", input: "x", response_format: "pcm" }), requestError(/response_format/, "response_format"));
  assert.throws(() => parseApiBody(apiVideoSchema, { model: "m", prompt: "x", seconds: 600 }), requestError(/seconds/, "seconds"));
  assert.throws(() => parseApiBody(apiVideoSchema, { model: "m", prompt: "x", image_asset_id: "not-a-uuid" }), requestError(/image_asset_id/, "image_asset_id"));
  assert.throws(() => parseApiBody(apiVideoSchema, "nope"), requestError(/./));
});
