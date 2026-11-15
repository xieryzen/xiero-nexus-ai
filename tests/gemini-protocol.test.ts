import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEmbedBody,
  buildGenerateBody,
  buildImageBody,
  buildSpeechBody,
  createGenerateStream,
  geminiBase,
  geminiHeaders,
  modelIdFromName,
  modelPath,
  modelsListPath,
  parseEmbedResponse,
  parseGenerateResponse,
  parseImageResponse,
  parseModelsPage,
  parseSpeechResponse,
  toGeminiContents,
  upstreamErrorMessage,
} from "../src/lib/adapters/gemini-protocol";
import type { ChatMessage } from "../src/lib/adapters/types";
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

// ─── Addresses and headers ───────────────────────────────────────────────────

test("a Base URL that is only the host gets the API version; one with a path is kept", () => {
  assert.equal(geminiBase("https://generativelanguage.googleapis.com"), "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(geminiBase("https://generativelanguage.googleapis.com/"), "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(geminiBase("https://generativelanguage.googleapis.com/v1beta/"), "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(geminiBase("https://proxy.example.com/gemini/v1"), "https://proxy.example.com/gemini/v1");
  assert.equal(geminiBase("not a url"), "not a url");
});

test("an API key goes in x-goog-api-key, whichever auth type is chosen", () => {
  for (const authType of ["bearer", "header"] as const) {
    assert.deepEqual(geminiHeaders({ authType, apiKey: "AIzaKey" }), {
      "content-type": "application/json",
      "x-goog-api-key": "AIzaKey",
    });
  }
  // Only a header named authorization carries a bearer token: that is for OAuth.
  assert.equal(geminiHeaders({ authType: "header", authHeaderName: "Authorization", apiKey: "ya29.token" }).authorization, "Bearer ya29.token");
  assert.equal(geminiHeaders({ authType: "header", authHeaderName: "x-proxy-key", apiKey: "k" })["x-proxy-key"], "k");
  assert.deepEqual(geminiHeaders({ authType: "none", apiKey: "k" }), { "content-type": "application/json" });
  assert.equal(geminiHeaders({ authType: "bearer", apiKey: "k", extraHeaders: { "X-Team": "a" } })["x-team"], "a");
});

test("a model id becomes a path; one that could change the address is refused", () => {
  assert.equal(modelPath("gemini-2.5-flash"), "/models/gemini-2.5-flash");
  assert.equal(modelPath("models/gemini-2.5-flash"), "/models/gemini-2.5-flash");
  assert.equal(modelPath("tunedModels/my-model"), "/tunedModels/my-model");
  for (const bad of ["", "a?key=x", "a#b", "../secret", "a/../b", "a b", "models//x", "a&b"]) {
    assert.throws(() => modelPath(bad), appError(400, "bad_request"), bad);
  }
  assert.equal(modelIdFromName("models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(modelsListPath({ pageSize: 1000 }), "/models?pageSize=1000");
  assert.equal(modelsListPath({ pageSize: 50, pageToken: "a b" }), "/models?pageSize=50&pageToken=a+b");
});

// ─── Requests ────────────────────────────────────────────────────────────────

test("system messages become the system instruction; turns alternate between user and model", () => {
  const { systemInstruction, contents } = toGeminiContents([
    { role: "system", content: "Be brief." },
    { role: "system", content: " And kind. " },
    { role: "user", content: "One" },
    { role: "user", content: "Two" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "   " },
  ]);
  assert.deepEqual(systemInstruction, { parts: [{ text: "Be brief.\n\nAnd kind." }] });
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "One" }, { text: "Two" }] },
    { role: "model", parts: [{ text: "Answer" }] },
  ]);
});

test("a tool turn from this adapter goes back as it came, with its thought signature", () => {
  const raw = [
    { text: "Let me save that." },
    { functionCall: { id: "fc_1", name: "write_file", args: { path: "a.txt" } }, thoughtSignature: "sig-123" },
  ];
  const messages: ChatMessage[] = [
    { role: "user", content: "Save it." },
    {
      role: "assistant",
      content: "Let me save that.",
      toolCalls: [{ id: "fc_1", name: "write_file", arguments: { path: "a.txt" } }],
      raw: { adapter: "gemini", content: raw },
    },
    { role: "tool", toolCallId: "fc_1", name: "write_file", content: "Saved." },
    { role: "tool", toolCallId: "fc_2", name: "read_file", content: "No such file.", isError: true },
  ];
  assert.deepEqual(toGeminiContents(messages).contents, [
    { role: "user", parts: [{ text: "Save it." }] },
    { role: "model", parts: raw },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "write_file", response: { result: "Saved." }, id: "fc_1" } },
        { functionResponse: { name: "read_file", response: { error: "No such file." }, id: "fc_2" } },
      ],
    },
  ]);
});

test("a tool turn from another provider is rebuilt from its calls; made-up ids are not sent", () => {
  const { contents } = toGeminiContents([
    { role: "user", content: "Go." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_abc", name: "list_files", arguments: {} },
        { id: "gemini-call-1-read_file", name: "read_file", arguments: { path: "a" } },
      ],
      raw: { adapter: "anthropic", content: [{ type: "thinking", thinking: "…" }] },
    },
    { role: "tool", toolCallId: "gemini-call-1-read_file", name: "read_file", content: "text" },
  ]);
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [
      { functionCall: { name: "list_files", args: {}, id: "call_abc" } },
      { functionCall: { name: "read_file", args: { path: "a" } } },
    ],
  });
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: "text" } } }] });
});

test("the request body: tools as function declarations, the choice as a mode, limits in generationConfig", () => {
  const tool = { name: "write_file", description: "Write", parameters: { type: "object", properties: {} } };
  const body = buildGenerateBody({
    model: "m",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
    tools: [tool],
    toolChoice: "required",
    temperature: 0.3,
    maxTokens: 900,
  });
  assert.deepEqual(body, {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: { parts: [{ text: "S" }] },
    tools: [{ functionDeclarations: [{ name: "write_file", description: "Write", parametersJsonSchema: tool.parameters }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    generationConfig: { temperature: 0.3, maxOutputTokens: 900 },
  });
  const plain = buildGenerateBody({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(Object.keys(plain), ["contents"]);
  assert.throws(() => buildGenerateBody({ model: "m", messages: [{ role: "system", content: "only" }] }), appError(400, "bad_request"));
});

// ─── Responses ───────────────────────────────────────────────────────────────

test("the answer is the text parts; thought summaries are left out, thinking counts as output", () => {
  const result = parseGenerateResponse({
    candidates: [{ content: { role: "model", parts: [{ text: "thinking…", thought: true }, { text: "Hello" }, { text: " there" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 20 },
  });
  assert.equal(result.content, "Hello there");
  assert.equal(result.finishReason, "STOP");
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 10, totalTokens: 20 });
  assert.equal(result.toolCalls, undefined);
  assert.equal(result.raw, undefined);
});

test("function calls become tool calls, and the parts are kept to be sent back", () => {
  const parts = [
    { functionCall: { id: "fc_9", name: "write_file", args: { path: "a" } }, thoughtSignature: "sig" },
    { functionCall: { name: "list_files" } },
  ];
  const result = parseGenerateResponse({ candidates: [{ content: { parts }, finishReason: "STOP" }] });
  assert.deepEqual(result.toolCalls, [
    { id: "fc_9", name: "write_file", arguments: { path: "a" } },
    { id: "gemini-call-1-list_files", name: "list_files", arguments: {} },
  ]);
  assert.deepEqual(result.raw, { adapter: "gemini", content: parts });
});

test("a blocked prompt, a withheld answer and an unreadable tool call are raised", () => {
  assert.throws(
    () => parseGenerateResponse({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Not allowed" } }),
    appError(422, "upstream_refusal", /\[SAFETY\] Not allowed/),
  );
  assert.throws(
    () => parseGenerateResponse({ candidates: [{ content: { parts: [] }, finishReason: "RECITATION" }] }),
    appError(422, "upstream_refusal", /RECITATION/),
  );
  assert.throws(
    () => parseGenerateResponse({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", finishMessage: "bad args" }] }),
    appError(502, "upstream_error", /could not be read: bad args/),
  );
  assert.throws(() => parseGenerateResponse({ candidates: [] }), appError(502, "upstream_error", /without candidates/));
  assert.throws(() => parseGenerateResponse("nope"), appError(502, "upstream_error"));
  // An answer that was cut for safety but has text is still the answer.
  assert.equal(parseGenerateResponse({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] }).content, "partial");
});

test("a stream yields its text as it arrives; the last usage is the total", () => {
  const seen: string[] = [];
  const stream = createGenerateStream((t) => seen.push(t));
  stream.handle(JSON.stringify({ candidates: [{ content: { parts: [{ text: "plan", thought: true }] } }] }));
  stream.handle(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }));
  stream.handle("not json");
  stream.handle(JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }));
  assert.deepEqual(seen, ["Hel", "lo"]);
  assert.deepEqual(stream.result(), { content: "Hello", finishReason: "STOP", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
});

test("a stream with a function call, an error event, or no events", () => {
  const withCall = createGenerateStream(() => undefined);
  withCall.handle(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "fc_1", name: "list_files", args: {} } }] }, finishReason: "STOP" }] }));
  assert.deepEqual(withCall.result().toolCalls, [{ id: "fc_1", name: "list_files", arguments: {} }]);

  const failing = createGenerateStream(() => undefined);
  assert.throws(() => failing.handle(JSON.stringify({ error: { code: 503, message: "The model is overloaded." } })), appError(502, "upstream_error", /overloaded/));

  assert.throws(() => createGenerateStream(() => undefined).result(), appError(502, "upstream_error", /no events/));
});

test("an upstream error shows the API's message, and never the key", () => {
  assert.equal(
    upstreamErrorMessage(400, JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } })),
    "Provider responded 400: API key not valid. Please pass a valid API key.",
  );
  assert.equal(upstreamErrorMessage(404, JSON.stringify([{ error: { message: "models/x is not found" } }])), "Provider responded 404: models/x is not found");
  assert.equal(upstreamErrorMessage(502, "", "Bad Gateway"), "Provider responded 502: Bad Gateway");
  const leaked = upstreamErrorMessage(400, JSON.stringify({ error: { message: "Bad key AIzaSyA1234567890-not-a-real-key in request ?key=AIzaSyA1234567890-not-a-real-key" } }));
  assert.ok(!leaked.includes("AIzaSyA1234567890"), leaked);
});

// ─── Models ──────────────────────────────────────────────────────────────────

test("the model list keeps what this adapter can use, and says what each model is for", () => {
  const page = parseModelsPage({
    models: [
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
      { name: "models/gemini-embedding-001", inputTokenLimit: 2048, supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/aqa", supportedGenerationMethods: ["generateAnswer"] },
      { name: "models/imagen-4", supportedGenerationMethods: ["predict"] },
      { nope: true },
    ],
    nextPageToken: "next",
  });
  assert.equal(page.nextPageToken, "next");
  assert.deepEqual(page.models, [
    {
      id: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      contextWindow: 1048576,
      capabilities: ["text", "tool_calling", "vision", "structured_output", "streaming", "reasoning"],
    },
    { id: "gemini-embedding-001", contextWindow: 2048, capabilities: ["embeddings"] },
    { id: "gemini-2.5-flash-preview-tts", capabilities: ["speech_generation"] },
    // An image model is not offered as a chat model: agents and routing would pick it up.
    { id: "gemini-2.5-flash-image", capabilities: ["image_generation"] },
  ]);
  assert.deepEqual(parseModelsPage({ models: [] }), { models: [], nextPageToken: undefined });
  assert.deepEqual(parseModelsPage(null).models, []);
});

// ─── Embeddings, images, speech ──────────────────────────────────────────────

test("embeddings are asked for in one batch, each text under the model's full name", () => {
  assert.deepEqual(buildEmbedBody({ model: "gemini-embedding-001", input: ["a", "b"], dimensions: 256 }), {
    requests: [
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] }, outputDimensionality: 256 },
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "b" }] }, outputDimensionality: 256 },
    ],
  });
  assert.deepEqual(parseEmbedResponse({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }, 2), { vectors: [[1, 2], [3, 4]] });
  assert.throws(() => parseEmbedResponse({ embeddings: [{ values: [1] }] }, 2), /fewer embeddings/);
  assert.throws(() => parseEmbedResponse({ embeddings: [{ values: ["x"] }] }, 1), /not a list of numbers/);
});

test("an image request asks for an image, in a shape the model takes", () => {
  assert.deepEqual(buildImageBody({ model: "m", prompt: "a lamp", aspectRatio: "9:16", resolution: "2k" }), {
    contents: [{ role: "user", parts: [{ text: "a lamp" }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "2K" } },
  });
  // A ratio or a resolution of another provider is left out rather than refused there.
  const body = buildImageBody({ model: "m", prompt: "a lamp", aspectRatio: "7:5", resolution: "720p" });
  assert.deepEqual(body.generationConfig, { responseModalities: ["TEXT", "IMAGE"] });
});

test("the images of an answer; an answer in words instead is an error that says so", () => {
  const ok = parseImageResponse({
    candidates: [{ content: { parts: [{ text: "Here." }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1290 },
  });
  assert.deepEqual(ok, { images: [{ b64: "QUJD" }], inputTokens: 5, outputTokens: 1290 });
  assert.match(parseImageResponse({ candidates: [{ content: { parts: [{ text: "I cannot draw that." }] }, finishReason: "STOP" }] }).error ?? "", /answered in text instead of an image: I cannot draw that/);
  assert.match(parseImageResponse({ candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] }).error ?? "", /no image \(IMAGE_SAFETY\)/);
  assert.match(parseImageResponse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }).error ?? "", /declined this request: \[PROHIBITED_CONTENT\]/);
});

test("speech: asked for as audio with a voice; the answer is the samples and how to read them", () => {
  assert.deepEqual(buildSpeechBody({ model: "m", input: "Hello", voice: "Puck", instructions: "Say cheerfully" }), {
    contents: [{ role: "user", parts: [{ text: "Say cheerfully: Hello" }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } },
  });
  assert.equal(
    (buildSpeechBody({ model: "m", input: "Hello" }).generationConfig as { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } }).speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    "Kore",
  );
  assert.deepEqual(
    parseSpeechResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAAA" } }] } }] }),
    { b64: "AAAA", mimeType: "audio/L16;codec=pcm;rate=24000" },
  );
  assert.throws(() => parseSpeechResponse({ candidates: [{ content: { parts: [] }, finishReason: "OTHER" }] }), appError(502, "upstream_error", /no audio \(OTHER\)/));
  assert.throws(() => parseSpeechResponse({ promptFeedback: { blockReason: "SAFETY" } }), appError(422, "upstream_refusal"));
});
