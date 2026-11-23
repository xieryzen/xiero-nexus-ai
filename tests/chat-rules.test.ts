import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_MAX_STEPS, CHAT_TITLE_MAX, callLine, titleFrom, toolsForModel, type ToolNote } from "../src/lib/chat/rules";

test("a conversation is called after the start of its first message", () => {
  assert.equal(titleFrom("ini vps ku, tolong cek\nIP: 1.2.3.4"), "ini vps ku, tolong cek");
  assert.equal(titleFrom("\n\n   Halo   apa   kabar  \nbaris kedua"), "Halo apa kabar");
  assert.equal(titleFrom(""), "New chat");
  assert.equal(titleFrom(" \n \n"), "New chat");
  const long = titleFrom("kata ".repeat(60));
  assert.equal(long.length <= CHAT_TITLE_MAX, true);
  assert.equal(long.endsWith("…"), true);
  // As long as a title may be: left whole.
  assert.equal(titleFrom("x".repeat(CHAT_TITLE_MAX)), "x".repeat(CHAT_TITLE_MAX));
});

test("a later answer is told what the tools of an earlier one did", () => {
  assert.equal(toolsForModel(undefined), "");
  assert.equal(toolsForModel([]), "");
  const note = (over: Partial<ToolNote>): ToolNote => ({ name: "run_on_server", summary: "uname -a", isError: false, durationMs: 12, result: "Linux vps 6.1", ...over });
  const told = toolsForModel([note({}), note({ name: "fetch_url", summary: "https://example.com", isError: true, result: "  404\n  Not Found  " }), note({ name: "remember", summary: "a note", result: "" })]);
  assert.equal(
    told,
    "\n\n(What you did for this answer with your tools, for your own reference:\n" +
      "1. run_on_server: uname -a -> Linux vps 6.1\n" +
      "2. fetch_url: https://example.com (failed) -> 404 Not Found\n" +
      "3. remember: a note)",
  );
  // The start of what came back, and the last calls where there were many.
  const cut = toolsForModel([note({ result: "a".repeat(900) })], 100);
  assert.equal(cut.includes(`${"a".repeat(99)}…`), true);
  assert.equal(cut.includes("a".repeat(101)), false);
  const many = toolsForModel(Array.from({ length: 20 }, (_, i) => note({ summary: `call ${i}` })));
  assert.equal(many.includes("call 7 "), false);
  assert.equal(many.includes("1. run_on_server: call 8 "), true);
  assert.equal(many.includes("12. run_on_server: call 19 "), true);
});

test("one line says what a tool was called with, and nothing that signs in", () => {
  assert.equal(callLine("run_on_server", { server: "vps-1-2-3-4", command: "df -h\n  && free -m" }), "vps-1-2-3-4: df -h && free -m");
  assert.equal(callLine("run_on_server", { command: "uptime" }), "uptime");
  assert.equal(callLine("http_request", { method: "post", url: "https://api.example.com/x", headers: { authorization: "Bearer {{key:token}}" }, body: "{}" }), "POST https://api.example.com/x");
  assert.equal(callLine("fetch_url", { url: "https://example.com" }), "https://example.com");
  assert.equal(callLine("web_search", { query: "harga vps murah" }), "harga vps murah");
  assert.equal(callLine("remember", { note: "Hana runs a shop." }), "Hana runs a shop.");
  assert.equal(callLine("recall", {}), "");
  assert.equal(callLine("run_on_server", { command: "x".repeat(300) }).length, 140);

  // keep_access: what is kept and where, never the password, the key or the private key.
  const server = callLine("keep_access", { kind: "server", host: "1.2.3.4", username: "deploy", password: "Rahasia#123", private_key: "-----BEGIN…", passphrase: "frasa" });
  assert.equal(server, "server deploy@1.2.3.4");
  assert.equal(callLine("keep_access", { kind: "server", host: "1.2.3.4", password: "Rahasia#123" }), "server root@1.2.3.4");
  assert.equal(callLine("keep_access", { kind: "site", url: "https://toko.example.com/login", username: "budi", password: "Rahasia#123" }), "site budi at https://toko.example.com/login");
  assert.equal(callLine("keep_access", { kind: "key", label: "Discord bot token", value: "MTIz.secret" }), "key Discord bot token");
  assert.equal(callLine("keep_access", { kind: "key", value: "MTIz.secret" }), "key a key");
  for (const line of [server, callLine("keep_access", { kind: "key", value: "MTIz.secret" })]) {
    assert.equal(/Rahasia#123|frasa|BEGIN|MTIz/.test(line), false);
  }

  // The browser: what is done, never what is typed.
  assert.equal(callLine("use_browser", { action: "open", url: "https://example.com/" }), "open https://example.com/");
  assert.equal(callLine("use_browser", { action: "type", element: 4, text: "Rahasia#123", submit: true }), "type into element 4, then Enter");
  assert.equal(callLine("use_browser", { action: "sign_in", account: "toko.example.com" }), "sign in with toko.example.com");
});

test("an answer takes a bounded number of steps", () => {
  assert.equal(CHAT_MAX_STEPS >= 8 && CHAT_MAX_STEPS <= 32, true);
});
