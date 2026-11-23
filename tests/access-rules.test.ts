import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC,
  HANDED_AT_ONCE,
  KEPT_HEADER,
  accessForModel,
  accountNameFor,
  fillKeys,
  freeName,
  hideValues,
  keptForModel,
  keptFromHeader,
  keptLine,
  keptToHeader,
  keyMark,
  keyMayGoTo,
  keyNameFor,
  keysForModel,
  keysNamed,
  markFor,
  mayHandOver,
  ownAccessMode,
  relevantTo,
  relevantToTask,
  says,
  serverNameFor,
  siteOfKey,
  type Kept,
} from "../src/lib/access/rules";

test("OWN_ACCESS: everyone hands access over unless it names fewer", () => {
  assert.equal(ownAccessMode(undefined), "everyone");
  assert.equal(ownAccessMode(""), "everyone");
  assert.equal(ownAccessMode(" Admins "), "admins");
  assert.equal(ownAccessMode("owners"), "owners");
  assert.equal(ownAccessMode("OFF"), "off");
  for (const no of ["0", "false", "no", "none"]) assert.equal(ownAccessMode(no), "off");
  // A word it does not know leaves it as it is by default.
  assert.equal(ownAccessMode("sometimes"), "everyone");

  const who = (mode: Parameters<typeof mayHandOver>[1]) => ["owner", "admin", "user", "guest", null].map((role) => mayHandOver(role, mode));
  assert.deepEqual(who("everyone"), [true, true, true, false, false]);
  assert.deepEqual(who("admins"), [true, true, false, false, false]);
  assert.deepEqual(who("owners"), [true, false, false, false, false]);
  assert.deepEqual(who("off"), [false, false, false, false, false]);
});

test("names: a machine by its address, a site by its host, a key by what it is called", () => {
  assert.equal(serverNameFor("203.0.113.7"), "vps-203-0-113-7");
  assert.equal(serverNameFor(" SRV1.Example.com "), "srv1.example.com");
  assert.equal(serverNameFor("a-very-long-name-of-a-machine.in-a-long-zone.example.com").length <= 36, true);
  assert.equal(serverNameFor("???"), "server");
  assert.equal(accountNameFor("https://www.Panel.example.com/login?next=/"), "panel.example.com");
  assert.equal(accountNameFor("http://203.0.113.9:8080/"), "203.0.113.9");
  assert.equal(accountNameFor("not a url"), "not-a-url");
  assert.equal(keyNameFor("Discord bot token"), "discord-bot-token");
  assert.equal(keyNameFor("  Token  API   Toko! "), "token-api-toko");
  assert.equal(keyNameFor("???"), "key");
});

test("a name that is taken gets a number", () => {
  assert.equal(freeName("vps-1-2-3-4", new Set()), "vps-1-2-3-4");
  assert.equal(freeName("api-key", new Set(["api-key"])), "api-key-2");
  assert.equal(freeName("api-key", new Set(["api-key", "api-key-2", "api-key-3"])), "api-key-4");
  // The number fits within the longest name.
  const long = "x".repeat(40);
  const next = freeName(long, new Set([long]));
  assert.equal(next.length, 40);
  assert.equal(next.endsWith("-2"), true);
});

test("keys are named in a text, filled in for the machine, and hidden from everything else", () => {
  assert.equal(keyMark("discord-bot-token"), "{{key:discord-bot-token}}");
  assert.deepEqual(keysNamed("Authorization: Bearer {{key:Token-API-Toko}} and {{ key : other.key }} and {{key:token-api-toko}}"), ["token-api-toko", "other.key"]);
  assert.deepEqual(keysNamed("no key here: {{key:}} {{ key }}"), []);

  const values = new Map([
    ["token-api-toko", "tk_live_9f8e7d6c5b4a"],
    ["short", "abc"],
    ["longer", "tk_live_9f8e7d6c5b4a_and_more"],
  ]);
  assert.equal(fillKeys("curl -H 'Authorization: Bearer {{key:token-api-toko}}' x", values), "curl -H 'Authorization: Bearer tk_live_9f8e7d6c5b4a' x");
  // A name without a value stays as it is written.
  assert.equal(fillKeys("{{key:missing}} {{KEY:Token-Api-Toko}}", values), "{{key:missing}} {{KEY:Token-Api-Toko}}".replace("{{KEY:Token-Api-Toko}}", "tk_live_9f8e7d6c5b4a"));

  // What comes back shows the name, never the value; a value that holds another goes whole.
  assert.equal(hideValues("got tk_live_9f8e7d6c5b4a_and_more and tk_live_9f8e7d6c5b4a", values), "got {{key:longer}} and {{key:token-api-toko}}");
  // A value too short to be told from ordinary text is left: hiding "abc" would garble everything.
  assert.equal(hideValues("abc abcdef", values), "abc abcdef");
});

test("the site a key is tied to", () => {
  assert.equal(siteOfKey("https://www.Toko.example.com/api/v1?x=1"), "toko.example.com");
  assert.equal(siteOfKey("discord.com"), "discord.com");
  assert.equal(siteOfKey("api.telegram.org:443"), "api.telegram.org");
  assert.equal(siteOfKey("http://203.0.113.9:8080/anything"), "203.0.113.9");
  // No site: a word, localhost, nothing.
  for (const none of ["", "  ", null, undefined, "localhost", "toko", "http://localhost:3000", "not a host at all"]) {
    assert.equal(siteOfKey(none), "", String(none));
  }
});

test("a key goes to the site it is for and to what is under it, and nowhere else", () => {
  assert.equal(keyMayGoTo("example.com", "example.com"), true);
  assert.equal(keyMayGoTo("example.com", "api.example.com"), true);
  assert.equal(keyMayGoTo("example.com", "www.example.com"), true);
  assert.equal(keyMayGoTo("https://www.example.com/x", "API.Example.com"), true);
  // Another site whose name only ends or starts the same.
  assert.equal(keyMayGoTo("example.com", "evilexample.com"), false);
  assert.equal(keyMayGoTo("example.com", "example.com.evil.net"), false);
  assert.equal(keyMayGoTo("api.example.com", "example.com"), false);
  // An address has nothing under it, and is matched exactly.
  assert.equal(keyMayGoTo("203.0.113.9", "203.0.113.9"), true);
  assert.equal(keyMayGoTo("203.0.113.9", "1.203.0.113.9"), false);
  assert.equal(keyMayGoTo("203.0.113.9", "203.0.113.90"), false);
  // A key that is tied to no site is sent to none.
  assert.equal(keyMayGoTo(null, "example.com"), false);
  assert.equal(keyMayGoTo("", "example.com"), false);
  assert.equal(keyMayGoTo("localhost", "localhost"), false);
  assert.equal(keyMayGoTo("example.com", ""), false);
});

test("says: a name or an address as a word of its own", () => {
  assert.equal(says("deploy ke vps-1-2-3-4 sekarang", "vps-1-2-3-4"), true);
  assert.equal(says("Cek 1.2.3.4.", "1.2.3.4"), true);
  assert.equal(says("(example.com)", "Example.com"), true);
  assert.equal(says("cek 11.2.3.45", "1.2.3.4"), false);
  assert.equal(says("cek 1.2.3.45", "1.2.3.4"), false);
  assert.equal(says("buka app.example.com", "example.com"), false);
  assert.equal(says("buka example.com.evil.net", "example.com"), false);
  assert.equal(says("my-vps-1-2-3-4", "vps-1-2-3-4"), false);
  assert.equal(says("anything", ""), false);
});

test("what a piece of work is handed: what its text names, or the only one of the kind it speaks of", () => {
  const a = { name: "vps-1-2-3-4", host: "1.2.3.4" };
  const b = { name: "srv.example.com", host: "srv.example.com" };
  // By name, by address.
  assert.deepEqual(relevantTo([a, b], "Deploy ke vps-1-2-3-4", GENERIC.server), [a]);
  assert.deepEqual(relevantTo([a, b], "Cek disk di 1.2.3.4 dan di srv.example.com", GENERIC.server), [a, b]);
  // It speaks of the kind and there is one: that one.
  assert.deepEqual(relevantTo([a], "Deploy ke VPS saya", GENERIC.server), [a]);
  // It speaks of the kind and there are several: none for a task, all for the one who plans.
  assert.deepEqual(relevantTo([a, b], "Deploy ke VPS saya", GENERIC.server), []);
  assert.deepEqual(relevantTo([a, b], "Deploy ke VPS saya", GENERIC.server, { offerAll: true }), [a, b]);
  // It is not about one at all.
  assert.deepEqual(relevantTo([a], "Tulis dua kalimat tentang kopi.", GENERIC.server), []);
  assert.deepEqual(relevantTo([a], "", GENERIC.server), []);
  assert.deepEqual(relevantTo([], "Deploy ke VPS", GENERIC.server), []);
  // A key by what the person called it.
  const key = { name: "token-api-toko", label: "token api toko" };
  assert.deepEqual(relevantTo([key, { name: "github-token", label: "GitHub token" }], "pakai token api toko untuk ambil pesanan", GENERIC.key), [key]);
  // No more than a piece of work is handed at once.
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `vps-${i}`, host: `10.0.0.${i}` }));
  assert.equal(relevantTo(many, many.map((m) => m.name).join(" "), GENERIC.server).length, HANDED_AT_ONCE);
});

test("a task of a run: by its own text; all of what the run works with when no task names any", () => {
  const a = { name: "vps-1-2-3-4", host: "1.2.3.4" };
  const b = { name: "vps-5-6-7-8", host: "5.6.7.8" };
  const texts = ["Tulis rencana.", "Deploy ke vps-1-2-3-4.", "Laporkan hasilnya."];
  assert.deepEqual(relevantToTask([a, b], texts[1]!, texts, GENERIC.server), [a]);
  // Another task of the same run is about it: this one is not handed it.
  assert.deepEqual(relevantToTask([a, b], texts[0]!, texts, GENERIC.server), []);
  // Steps written for every project: only the goal said where the work is done.
  const general = ["Kerjakan langkah pertama.", "Periksa hasilnya."];
  assert.deepEqual(relevantToTask([a, b], general[0]!, general, GENERIC.server), [a, b]);
  assert.deepEqual(relevantToTask([], general[0]!, general, GENERIC.server), []);
});

test("what a person is told became of what they handed over", () => {
  const kept: Kept = { kind: "server", name: "vps-1-2-3-4", where: "root@1.2.3.4:22", ok: true, updated: false, note: "The app signed in and ran one harmless command." };
  assert.equal(keptLine(kept), 'Server root@1.2.3.4:22: kept as "vps-1-2-3-4". The app signed in and ran one harmless command.');
  assert.equal(keptLine({ ...kept, updated: true }), 'Server root@1.2.3.4:22: kept again as "vps-1-2-3-4". The app signed in and ran one harmless command.');
  assert.equal(keptLine({ ...kept, ok: false, name: "", note: "The app could not sign in." }), "Server root@1.2.3.4:22: not kept. The app could not sign in.");
  assert.equal(keptLine({ ...kept, kind: "site", where: "budi at toko.example.com" }).startsWith("Site account budi at toko.example.com: kept"), true);
  assert.equal(keptLine({ ...kept, kind: "key", where: "Discord bot token" }).startsWith("Key Discord bot token: kept"), true);

  assert.equal(markFor("password", kept), '[password kept by the app as "vps-1-2-3-4"]');
  assert.equal(markFor("private key", { ...kept, ok: false }), "[private key taken out by the app]");
});

test("what was kept travels in a header and comes back as it was", () => {
  assert.equal(KEPT_HEADER, "x-access-kept");
  const kept: Kept[] = [
    { kind: "server", name: "vps-1-2-3-4", where: "root@1.2.3.4:22", ok: true, updated: true, note: "Sistem: Ubuntu 22.04 — “aman”." },
    { kind: "key", name: "", where: "Kunci toko", ok: false, updated: false, note: "Tidak disimpan." },
  ];
  const header = keptToHeader(kept);
  // A header holds no characters beyond ASCII.
  assert.match(header, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(keptFromHeader(header), kept);
  // Long texts are cut, and no more than a few entries are sent.
  const long = keptFromHeader(keptToHeader(Array.from({ length: 9 }, () => ({ ...kept[0]!, where: "w".repeat(300), note: "n".repeat(900) }))));
  assert.equal(long.length, 6);
  assert.equal(long[0]!.where.length, 120);
  assert.equal(long[0]!.note.length, 400);
  // What is not ours is nothing.
  for (const bad of [null, undefined, "", "not base64 !!", btoa("{}"), btoa("[1, 2]"), btoa('[{"kind":"car","name":"a","where":"b","ok":true,"note":""}]')]) {
    assert.deepEqual(keptFromHeader(bad), [], String(bad));
  }
});

test("what the model is told after a message: what was kept under which name, and what was not", () => {
  assert.equal(keptForModel([]), "");
  const told = keptForModel([
    { kind: "server", name: "vps-1-2-3-4", where: "root@1.2.3.4:22", ok: true, updated: false, note: "Signed in." },
    { kind: "site", name: "toko.example.com", where: "budi at toko.example.com", ok: true, updated: true, note: "Tried at first use." },
    { kind: "key", name: "token-api-toko", where: "token api toko", ok: true, updated: false, note: "Write {{key:token-api-toko}}." },
    { kind: "server", name: "", where: "root@5.6.7.8:22", ok: false, updated: false, note: "The app could not sign in." },
  ]);
  assert.match(told, /Note from the app, not from the person/);
  assert.match(told, /- Server "vps-1-2-3-4" \(root@1\.2\.3\.4:22\): kept\. Signed in\. Work on it with run_on_server\./);
  assert.match(told, /- Site account "toko\.example\.com" \(budi at toko\.example\.com\): kept again with the new password\./);
  assert.match(told, /- Key "token-api-toko" \(token api toko\): kept\./);
  assert.match(told, /- Server root@5\.6\.7\.8:22: NOT kept\. The app could not sign in\./);
});

test("what the assistant is told it can reach: names, never what signs in", () => {
  assert.equal(accessForModel([], [], [], true), "");
  const servers = [{ name: "vps-1-2-3-4", username: "root", host: "1.2.3.4", port: 22, notes: "toko" }, { name: "srv", username: "deploy", host: "srv.example.com", port: 2222 }];
  const sites = [{ name: "toko.example.com", siteUrl: "https://toko.example.com/login", username: "budi" }];
  const keys = [{ name: "token-api-toko", label: "token api toko", site: "toko.example.com" }, { name: "mysql-password", label: "mysql password", site: null }];
  const told = accessForModel(servers, sites, keys, true);
  assert.match(told, /Servers you can work on with run_on_server/);
  assert.match(told, /- vps-1-2-3-4: root@1\.2\.3\.4 \(toko\)/);
  assert.match(told, /- srv: deploy@srv\.example\.com:2222/);
  assert.match(told, /Site accounts you can sign in with in the browser/);
  assert.match(told, /- toko\.example\.com: budi at https:\/\/toko\.example\.com\/login/);
  assert.match(told, /- \{\{key:token-api-toko\}\}: token api toko\. In a web request it is sent only to toko\.example\.com/);
  assert.match(told, /- \{\{key:mysql-password\}\}: mysql password\. It is tied to no site, so it is sent in no web request; it can be written into a command on a server\./);
  // Without a browser the site accounts are named, and the model is told that it cannot sign in from here.
  assert.match(accessForModel([], sites, [], false), /no browser is set up on this installation/);
  assert.equal(keysForModel([]), "");
});
