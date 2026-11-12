import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTHROPIC_DEFAULT_API_VERSION,
  ANTHROPIC_MAX_TOKENS,
  anthropicHeaders,
  buildMessagesPayload,
  createMessageStream,
  createSseParser,
  modelsPath,
  parseMessageResponse,
  parseModelsPage,
  toAnthropicMessages,
  upstreamErrorMessage,
} from "../src/lib/adapters/anthropic-protocol";
import { AppError } from "../src/lib/errors";

function appError(status: number, code: string, message?: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  };
}

// ─── Headers ──────────────────────────────────────────────────────────────────

test("bearer auth sends the key as Authorization, with the default API version", () => {
  assert.deepEqual(anthropicHeaders({ authType: "bearer", apiKey: "sk-ant-test" }), {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_DEFAULT_API_VERSION,
    authorization: "Bearer sk-ant-test",
  });
});

test("header auth sends the key in x-api-key, or in the configured header", () => {
  const byDefault = anthropicHeaders({ authType: "header", apiKey: "k" });
  assert.equal(byDefault["x-api-key"], "k");
  assert.equal(byDefault["authorization"], undefined);

  const custom = anthropicHeaders({ authType: "header", authHeaderName: "X-Proxy-Key", apiKey: "k" });
  assert.equal(custom["x-proxy-key"], "k");
  assert.equal(custom["x-api-key"], undefined);
});

test("auth type none sends no credential", () => {
  const h = anthropicHeaders({ authType: "none", apiKey: "k" });
  assert.deepEqual(Object.keys(h).sort(), ["anthropic-version", "content-type"]);
});

test("the provider's API version replaces the default; a blank one does not", () => {
  const version = (apiVersion: string | null) =>
    anthropicHeaders({ authType: "none", apiVersion })["anthropic-version"];
  assert.equal(version("2023-06-01"), "2023-06-01");
  assert.equal(version(" 2023-06-01 "), "2023-06-01");
  assert.equal(version(""), ANTHROPIC_DEFAULT_API_VERSION);
  assert.equal(version("   "), ANTHROPIC_DEFAULT_API_VERSION);
  assert.equal(version(null), ANTHROPIC_DEFAULT_API_VERSION);
});

test("extra headers are added in lower case and win over built-in ones", () => {
  const h = anthropicHeaders({
    authType: "bearer",
    apiKey: "k",
    extraHeaders: { "Anthropic-Beta": "some-beta", "Anthropic-Version": "2023-06-01" },
  });
  assert.equal(h["anthropic-beta"], "some-beta");
  assert.equal(h["anthropic-version"], "2023-06-01");
});

// ─── Request body ─────────────────────────────────────────────────────────────

test("system messages become the top-level system prompt", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "system", content: " Answer in Indonesian. " },
    { role: "user", content: "Apa kabar?" },
  ]);
  assert.equal(system, "Be brief.\n\nAnswer in Indonesian.");
  assert.deepEqual(messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: "Apa kabar?" },
  ]);
});

test("blank messages are dropped, and no system prompt means no system field", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "  " },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "\n" },
    { role: "user", content: "Still there?" },
  ]);
  assert.equal(system, undefined);
  assert.deepEqual(messages, [
    { role: "user", content: "Hi" },
    { role: "user", content: "Still there?" },
  ]);
});

test("the request body carries max_tokens and never a sampling parameter", () => {
  const body = buildMessagesPayload(
    {
      model: "claude-opus-5-5",
      temperature: 0,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    },
    { stream: false },
  );
  assert.deepEqual(body, {
    model: "claude-opus-5-5",
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: "Be brief.",
    messages: [{ role: "user", content: "Hi" }],
  });
});

test("the request body asks for a stream only when streaming", () => {
  const req = { model: "m", messages: [{ role: "user" as const, content: "Hi" }] };
  assert.equal(buildMessagesPayload(req, { stream: true }).stream, true);
  assert.equal("stream" in buildMessagesPayload(req, { stream: false }), false);
  assert.equal("system" in buildMessagesPayload(req, { stream: false }), false);
});

test("a request with no user or assistant turn is rejected before it is sent", () => {
  assert.throws(
    () =>
      buildMessagesPayload(
        { model: "m", messages: [{ role: "system", content: "Be brief." }] },
        { stream: false },
      ),
    appError(400, "bad_request"),
  );
});

// ─── Non-streaming response ───────────────────────────────────────────────────

test("the reply is the text blocks only; thinking blocks are left out", () => {
  const result = parseMessageResponse({
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "EosnCkYICxIMMb3LzNrMu" },
      { type: "text", text: "The answer " },
      { type: "tool_use", id: "toolu_1", name: "calc", input: {} },
      { type: "text", text: "is 21." },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  assert.equal(result.content, "The answer is 21.");
  assert.equal(result.finishReason, "end_turn");
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
});

test("prompt tokens include cached input, and the total is computed", () => {
  const result = parseMessageResponse({
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 15,
      cache_creation_input_tokens: 3546,
      cache_read_input_tokens: 1000,
      output_tokens: 7,
    },
  });
  assert.deepEqual(result.usage, { promptTokens: 4561, completionTokens: 7, totalTokens: 4568 });
});

test("a response without usage reports none, so callers estimate it", () => {
  const result = parseMessageResponse({ content: [{ type: "text", text: "ok" }] });
  assert.equal(result.usage, undefined);
  assert.equal(result.finishReason, undefined);
});

test("a refusal is raised with the provider's category and explanation", () => {
  assert.throws(
    () =>
      parseMessageResponse({
        content: [],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "This request was declined because it could enable cyber harm.",
        },
        usage: { input_tokens: 412, output_tokens: 0 },
      }),
    appError(422, "upstream_refusal", /\[cyber\] This request was declined/),
  );
  // Category and explanation are null when the refusal has no named category.
  assert.throws(
    () =>
      parseMessageResponse({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: null },
      }),
    appError(422, "upstream_refusal", /^The model declined this request$/),
  );
});

test("a 200 body that is not an Anthropic message is rejected", () => {
  for (const body of [null, "ok", [], {}, { choices: [{ message: { content: "hi" } }] }]) {
    assert.throws(() => parseMessageResponse(body), appError(502, "upstream_error"));
  }
});

// ─── Models and errors ────────────────────────────────────────────────────────

test("the models path carries the page size and an encoded cursor", () => {
  assert.equal(modelsPath({ limit: 1 }), "/models?limit=1");
  assert.equal(
    modelsPath({ limit: 1000, afterId: "claude opus/4" }),
    "/models?limit=1000&after_id=claude+opus%2F4",
  );
});

test("a models page yields its ids, and a cursor only while more pages exist", () => {
  assert.deepEqual(
    parseModelsPage({
      data: [
        { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
        { type: "model", id: "claude-haiku-5-5" },
        { type: "model" },
        null,
      ],
      first_id: "claude-opus-5-5",
      has_more: true,
      last_id: "claude-haiku-5-5",
    }),
    { ids: ["claude-opus-5-5", "claude-haiku-5-5"], nextAfterId: "claude-haiku-5-5" },
  );
  assert.deepEqual(
    parseModelsPage({ data: [{ id: "claude-sonnet-5-5" }], has_more: false, last_id: "claude-sonnet-5-5" }),
    { ids: ["claude-sonnet-5-5"], nextAfterId: undefined },
  );
  assert.deepEqual(parseModelsPage("not a page"), { ids: [], nextAfterId: undefined });
});

test("an upstream error shows the API's message, or the raw body when it has none", () => {
  assert.equal(
    upstreamErrorMessage(
      401,
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
        request_id: "req_018EeWyXxfu5pfWkrYcMdjWG",
      }),
    ),
    "Provider responded 401: invalid x-api-key",
  );
  assert.equal(
    upstreamErrorMessage(502, "<html>Bad Gateway</html>"),
    "Provider responded 502: <html>Bad Gateway</html>",
  );
  assert.equal(upstreamErrorMessage(404, "", "Not Found"), "Provider responded 404: Not Found");
  assert.equal(upstreamErrorMessage(500, "null"), "Provider responded 500: null");
});

test("an upstream error that echoes the key does not repeat it", () => {
  const secret = "A1b2C3d4".repeat(12);
  const key = `sk-ant-api03-${secret}`;
  for (const echoed of [`invalid key ${key}`, `invalid header: Bearer ${key}`]) {
    const message = upstreamErrorMessage(401, JSON.stringify({ error: { message: echoed } }));
    assert.equal(message.includes(secret), false, message);
    assert.equal(message.includes("A1b2C3d4"), false, message);
  }
});

// ─── Server-sent events ───────────────────────────────────────────────────────

const sseEvent = (type: string, body: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

const textDelta = (text: string) =>
  sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } });

/** The event flow of a short streamed reply, as the API documents it. */
const HELLO_STREAM =
  sseEvent("message_start", {
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-opus-5-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1 },
    },
  }) +
  sseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  sseEvent("ping") +
  textDelta("Hello") +
  textDelta("!") +
  sseEvent("content_block_stop", { index: 0 }) +
  sseEvent("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 15 },
  }) +
  sseEvent("message_stop");

function parseAll(text: string, chunkSize: number) {
  const parser = createSseParser();
  const events = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push(...parser.push(text.slice(i, i + chunkSize)));
  }
  events.push(...parser.flush());
  return events;
}

function runStream(text: string, chunkSize = text.length) {
  const deltas: string[] = [];
  const message = createMessageStream((t) => deltas.push(t));
  for (const event of parseAll(text, chunkSize)) message.handle(event);
  return { deltas, message };
}

test("events parse the same however the stream is cut into chunks", () => {
  const whole = parseAll(HELLO_STREAM, HELLO_STREAM.length);
  assert.equal(whole.length, 8);
  assert.deepEqual(whole[0]?.event, "message_start");
  assert.deepEqual(whole[2], { event: "ping", data: '{"type":"ping"}' });
  for (const size of [1, 2, 7, 64]) {
    assert.deepEqual(parseAll(HELLO_STREAM, size), whole, `chunk size ${size}`);
  }
});

test("CRLF line endings parse, also when a chunk ends between CR and LF", () => {
  const crlf = HELLO_STREAM.replace(/\n/g, "\r\n");
  const expected = parseAll(HELLO_STREAM, HELLO_STREAM.length);
  for (const size of [1, 3, crlf.length]) {
    assert.deepEqual(parseAll(crlf, size), expected, `chunk size ${size}`);
  }
});

test("comments are skipped, data lines are joined, and a last event needs no blank line", () => {
  const events = parseAll(": keep-alive\n\nevent: a\ndata: one\ndata:two\n\ndata: tail", 5);
  assert.deepEqual(events, [
    { event: "a", data: "one\ntwo" },
    { event: null, data: "tail" },
  ]);
});

// ─── Streamed message ─────────────────────────────────────────────────────────

test("a streamed reply yields its deltas, usage and stop reason", () => {
  for (const size of [1, 16, HELLO_STREAM.length]) {
    const { deltas, message } = runStream(HELLO_STREAM, size);
    assert.deepEqual(deltas, ["Hello", "!"]);
    assert.deepEqual(message.result(), {
      content: "Hello!",
      // Input tokens come from message_start; message_delta only has the output count.
      usage: { promptTokens: 25, completionTokens: 15, totalTokens: 40 },
      finishReason: "end_turn",
    });
  }
});

test("counters repeated in message_delta replace the earlier ones", () => {
  const { message } = runStream(
    sseEvent("message_start", {
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } },
    }) +
      textDelta("ok") +
      sseEvent("message_delta", {
        delta: { stop_reason: "max_tokens" },
        usage: { input_tokens: 12, cache_read_input_tokens: null, output_tokens: 9 },
      }) +
      sseEvent("message_stop"),
  );
  assert.deepEqual(message.result(), {
    content: "ok",
    usage: { promptTokens: 17, completionTokens: 9, totalTokens: 26 },
    finishReason: "max_tokens",
  });
});

test("thinking, signature and tool-input deltas are not part of the reply", () => {
  const delta = (index: number, body: Record<string, unknown>) =>
    sseEvent("content_block_delta", { index, delta: body });
  const { deltas, message } = runStream(
    sseEvent("message_start", { message: { usage: { input_tokens: 5, output_tokens: 1 } } }) +
      delta(0, { type: "thinking_delta", thinking: "Use the Euclidean algorithm." }) +
      delta(0, { type: "signature_delta", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3h" }) +
      delta(1, { type: "text_delta", text: "21" }) +
      delta(2, { type: "input_json_delta", partial_json: '{"location":' }) +
      sseEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }) +
      sseEvent("message_stop"),
  );
  assert.deepEqual(deltas, ["21"]);
  assert.equal(message.result().content, "21");
});

test("unknown event types and malformed data are skipped", () => {
  const { deltas, message } = runStream(
    sseEvent("message_start", { message: { usage: { input_tokens: 5, output_tokens: 1 } } }) +
      sseEvent("some_future_event", { anything: true }) +
      "event: content_block_delta\ndata: {not json\n\n" +
      "data: 42\n\n" +
      textDelta("ok") +
      sseEvent("message_stop"),
  );
  assert.deepEqual(deltas, ["ok"]);
  assert.equal(message.result().content, "ok");
});

test("an error event in the stream is raised as an upstream error", () => {
  const stream =
    sseEvent("message_start", { message: { usage: { input_tokens: 5, output_tokens: 1 } } }) +
    textDelta("partial") +
    sseEvent("error", { error: { type: "overloaded_error", message: "Overloaded" } });
  assert.throws(
    () => runStream(stream),
    appError(502, "upstream_error", /^Provider stream error: overloaded_error: Overloaded$/),
  );
  // The event name alone marks an error, even if its data is not JSON.
  assert.throws(
    () => runStream("event: error\ndata: upstream went away\n\n"),
    appError(502, "upstream_error", /upstream went away/),
  );
});

test("a refusal that arrives mid-stream is raised once the stream ends", () => {
  const { deltas, message } = runStream(
    sseEvent("message_start", { message: { usage: { input_tokens: 412, output_tokens: 1 } } }) +
      textDelta("Sure, first you") +
      sseEvent("message_delta", {
        delta: {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "bio", explanation: "Declined." },
        },
        usage: { output_tokens: 6 },
      }) +
      sseEvent("message_stop"),
  );
  assert.deepEqual(deltas, ["Sure, first you"]);
  assert.throws(() => message.result(), appError(422, "upstream_refusal", /\[bio\] Declined\./));
});

test("a stream with no message events is rejected instead of read as an empty reply", () => {
  assert.throws(() => runStream("").message.result(), appError(502, "upstream_error"));
  assert.throws(
    () => runStream(sseEvent("ping") + ": keep-alive\n\n").message.result(),
    appError(502, "upstream_error"),
  );
  // An OpenAI-style stream is not an Anthropic message either.
  assert.throws(
    () =>
      runStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n').message.result(),
    appError(502, "upstream_error"),
  );
});
