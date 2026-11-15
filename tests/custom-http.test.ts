import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUSTOM_HTTP_EXAMPLE,
  MAX_CUSTOM_CONFIG_CHARS,
  buildChatRequest,
  flattenPrompt,
  getPath,
  parseChatResponse,
  parseCustomHttpConfig,
  parseModelList,
  renderPath,
  renderTemplate,
  templateVars,
} from "../src/lib/adapters/custom-http-protocol";
import type { ChatMessage } from "../src/lib/adapters/types";
import { AppError } from "../src/lib/errors";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "What is a lighthouse?" },
  { role: "assistant", content: "A tower with a light." },
  { role: "user", content: "And a buoy?" },
];

function badRequest(message: RegExp) {
  return (err: unknown) => err instanceof AppError && err.status === 400 && message.test(err.message);
}

// ─── Configuration ───────────────────────────────────────────────────────────

test("the example configuration is a valid one", () => {
  const parsed = parseCustomHttpConfig(JSON.stringify(CUSTOM_HTTP_EXAMPLE));
  assert.equal(parsed.chat.path, "/api/chat");
  assert.equal(parsed.chat.method, "POST");
  assert.equal(parsed.models?.idPath, "name");
});

test("a configuration says what is wrong with it", () => {
  assert.throws(() => parseCustomHttpConfig(""), badRequest(/no configuration yet/));
  assert.throws(() => parseCustomHttpConfig("   "), badRequest(/no configuration yet/));
  assert.throws(() => parseCustomHttpConfig("{not json"), badRequest(/not valid JSON/));
  assert.throws(() => parseCustomHttpConfig(JSON.stringify({ chat: { path: "/x" } })), badRequest(/chat\.body/));
  assert.throws(
    () => parseCustomHttpConfig(JSON.stringify({ chat: { path: "no-slash", body: {}, responsePath: "a" } })),
    badRequest(/chat\.path: A path must start with \//),
  );
  assert.throws(
    () => parseCustomHttpConfig(JSON.stringify({ chat: { body: {}, responsePath: "a b" } })),
    badRequest(/chat\.responsePath/),
  );
  assert.throws(
    () => parseCustomHttpConfig(JSON.stringify({ chat: { body: {}, responsePath: "a", method: "GET" } })),
    badRequest(/chat\.method/),
  );
  assert.throws(() => parseCustomHttpConfig("x".repeat(MAX_CUSTOM_CONFIG_CHARS + 1)), badRequest(/longer than/));
  // The path may be empty: the Base URL is then the address itself.
  assert.equal(parseCustomHttpConfig(JSON.stringify({ chat: { body: {}, responsePath: "text" } })).chat.path, "");
});

// ─── Requests ────────────────────────────────────────────────────────────────

test("what a template can use: the conversation in several forms", () => {
  const vars = templateVars({ model: "llama", messages: MESSAGES, temperature: 0.4 });
  assert.equal(vars.model, "llama");
  assert.equal(vars.system, "Be brief.");
  assert.equal(vars.last_user_message, "And a buoy?");
  assert.deepEqual(vars.messages, MESSAGES.map((m) => ({ role: m.role, content: m.content })));
  assert.deepEqual(vars.chat_messages, MESSAGES.slice(1).map((m) => ({ role: m.role, content: m.content })));
  assert.equal(
    vars.prompt,
    "System: Be brief.\n\nUser: What is a lighthouse?\n\nAssistant: A tower with a light.\n\nUser: And a buoy?\n\nAssistant:",
  );
  assert.equal(vars.temperature, 0.4);
  assert.equal(vars.max_tokens, undefined);
  // A lone user message is the prompt as it is.
  assert.equal(flattenPrompt([{ role: "user", content: "Hello" }]), "Hello");
});

test("tool turns are written as plain text: such an API knows nothing about tools", () => {
  const vars = templateVars({
    model: "m",
    messages: [
      { role: "user", content: "Go" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "list_files", arguments: {} }] },
      { role: "tool", toolCallId: "1", name: "list_files", content: "a.txt" },
    ],
  });
  assert.deepEqual(vars.messages, [
    { role: "user", content: "Go" },
    { role: "user", content: "Tool result (list_files):\na.txt" },
  ]);
});

test("a placeholder that is the whole value keeps its type; inside a text it becomes text", () => {
  const vars = templateVars({ model: "llama", messages: MESSAGES, temperature: 0.4 });
  const body = renderTemplate(
    {
      model: "{{model}}",
      messages: "{{ messages }}",
      stream: false,
      note: "Model {{model}} at {{temperature}}",
      options: { temperature: "{{temperature}}", num_predict: "{{max_tokens}}" },
      limits: { max: "{{max_tokens}}" },
      list: ["{{model}}", "{{max_tokens}}", 3],
      other: "{{not_ours}}",
    },
    vars,
  );
  assert.deepEqual(body, {
    model: "llama",
    messages: vars.messages,
    stream: false,
    note: "Model llama at 0.4",
    // A key whose placeholder has no value is left out, and so is an object that lost all its keys.
    options: { temperature: 0.4 },
    list: ["llama", 3],
    // Not one of the placeholders: kept as written.
    other: "{{not_ours}}",
  });
});

test("the request is built from the configuration; a model id keeps its slashes in a path", () => {
  const config = parseCustomHttpConfig(
    JSON.stringify({ chat: { path: "/run/{{model}}", method: "PUT", body: { prompt: "{{prompt}}" }, responsePath: "result.response" } }),
  );
  const wire = buildChatRequest(config, { model: "@cf/meta/llama 3", messages: [{ role: "user", content: "Hi" }] });
  assert.deepEqual(wire, { path: "/run/%40cf/meta/llama%203", method: "PUT", body: { prompt: "Hi" } });
  assert.equal(renderPath("/v1/{{ model }}/chat", "a/b"), "/v1/a/b/chat");
});

// ─── Responses ───────────────────────────────────────────────────────────────

test("a path points into the response", () => {
  const doc = { choices: [{ message: { content: "Hi" } }], usage: { in: 3 }, list: ["a", "b"] };
  assert.equal(getPath(doc, "choices[0].message.content"), "Hi");
  assert.equal(getPath(doc, "choices.0.message.content"), "Hi");
  assert.equal(getPath(doc, "usage.in"), 3);
  assert.equal(getPath(doc, "list[1]"), "b");
  assert.equal(getPath(doc, "choices[1].message"), undefined);
  assert.equal(getPath(doc, "choices.first"), undefined);
  assert.equal(getPath(doc, "usage.in.deeper"), undefined);
  assert.equal(getPath(null, "a"), undefined);
});

test("the answer and the token counts are read where the configuration says", () => {
  const config = parseCustomHttpConfig(JSON.stringify(CUSTOM_HTTP_EXAMPLE));
  assert.deepEqual(parseChatResponse(config, { message: { content: "Hello" }, prompt_eval_count: 9, eval_count: 5 }), {
    content: "Hello",
    usage: { promptTokens: 9, completionTokens: 5, totalTokens: 14 },
  });
  // Without counts, the caller estimates them.
  assert.deepEqual(parseChatResponse(config, { message: { content: "Hello" } }), { content: "Hello", usage: undefined });
  // A list of text pieces is joined.
  const pieces = parseCustomHttpConfig(JSON.stringify({ chat: { body: {}, responsePath: "output" } }));
  assert.equal(parseChatResponse(pieces, { output: ["Hel", "lo"] }).content, "Hello");
});

test("an error inside a 200 answer is raised; a wrong response path says where to look", () => {
  const config = parseCustomHttpConfig(JSON.stringify(CUSTOM_HTTP_EXAMPLE));
  assert.throws(
    () => parseChatResponse(config, { error: "model 'x' not found" }),
    (err: unknown) => err instanceof AppError && err.status === 502 && /Provider error: model 'x' not found/.test(err.message),
  );
  assert.throws(
    () => parseChatResponse(config, { error: { message: "bad", key: "sk-abcdefghijklmnop123456" } }),
    (err: unknown) => err instanceof AppError && !/sk-abcdefghijklmnop/.test(err.message),
  );
  assert.throws(() => parseChatResponse(config, { reply: "Hello" }), /no text at "message\.content"/);
});

test("the model list is read where the configuration says", () => {
  const config = parseCustomHttpConfig(JSON.stringify(CUSTOM_HTTP_EXAMPLE));
  assert.deepEqual(parseModelList(config, { models: [{ name: "a" }, { name: "b" }, { name: "a" }, { other: 1 }, { name: "" }] }), [{ id: "a" }, { id: "b" }]);
  assert.throws(() => parseModelList(config, { data: [] }), /not where the provider's configuration says/);
  // The response itself can be the list, and the items the ids.
  const bare = parseCustomHttpConfig(JSON.stringify({ chat: { body: {}, responsePath: "t" }, models: { path: "/models" } }));
  assert.deepEqual(parseModelList(bare, ["x", "y", 3]), [{ id: "x" }, { id: "y" }]);
  // No models section: nothing to list.
  assert.deepEqual(parseModelList(parseCustomHttpConfig(JSON.stringify({ chat: { body: {}, responsePath: "t" } })), {}), []);
});
