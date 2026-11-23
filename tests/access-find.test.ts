import { test } from "node:test";
import assert from "node:assert/strict";
import { appMarks, findAccess, isHost, isIpv4, replaceSpans, type Found } from "../src/lib/access/find";
import { markFor, keyMark, type Kept } from "../src/lib/access/rules";

/** What was found, a line each: enough to tell a server from a site from a key, and what signs in. */
function summary(found: Found[]): string[] {
  return found.map(({ item }) => {
    if (item.kind === "server") {
      const how = item.privateKey ? `key${item.passphrase ? `+${item.passphrase}` : ""}` : item.password;
      return `server ${item.username}@${item.host}:${item.port} ${how}`;
    }
    if (item.kind === "site") return `site ${item.username} at ${item.url} ${item.password}`;
    return `key "${item.label}" ${item.value} -> ${item.site ?? "no site"}`;
  });
}

/** The text with every secret that was found struck out. */
function struck(text: string): string {
  return replaceSpans(
    text,
    findAccess(text).flatMap((f) => f.secrets.map((s) => ({ start: s.start, end: s.end, with: `[${s.what}]` }))),
  );
}

// Made-up keys in the shapes the app knows, put together here so that no line of this file is one.
const DISCORD = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GabcdE", "abcdefghijklmnopqrstuvwxyz0123456789"].join(".");
const GITHUB = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
const TELEGRAM = `${"123456789"}:${"AAabcdefghijklmnopqrstuvwxyz0123456"}`;
const PTERODACTYL = `ptlc_${"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}`;
const OPENAI = `sk-${"proj"}-${"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}`;
const PLAIN_SK = `sk-${"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}`;

const KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";

function each(cases: [string, string[]][]): void {
  for (const [text, expected] of cases) {
    assert.deepEqual(summary(findAccess(text)), expected, JSON.stringify(text));
  }
}

test("a server: an address, who to sign in as, and a password", () => {
  each([
    ["ini vps ku, tolong cek\nIP: 103.150.60.19\nPort: 22\nUser: root\nPass: Rahasia#123", ["server root@103.150.60.19:22 Rahasia#123"]],
    ["VPS 203.0.113.9 port 2222 user deploy pass Abc123!x, tolong restart nginx", ["server deploy@203.0.113.9:2222 Abc123!x"]],
    ["ssh root@203.0.113.9 password Abc123!x", ["server root@203.0.113.9:22 Abc123!x"]],
    ["ssh deploy@srv1.example.com -p 2200 pw: s3cr3t.Pass", ["server deploy@srv1.example.com:2200 s3cr3t.Pass"]],
    ["root@203.0.113.9:2222 pass: hunter2A", ["server root@203.0.113.9:2222 hunter2A"]],
    ["IP 203.0.113.9\nusername = admin\npassword = \"dua kata sandi\"", ["server admin@203.0.113.9:22 dua kata sandi"]],
    ['{"host": "203.0.113.9", "port": 2022, "username": "root", "password": "p@ss,w0rd"}', ["server root@203.0.113.9:2022 p@ss,w0rd"]],
    ["notes.txt ada di server, password: Abc12345 user: root ip: 203.0.113.9", ["server root@203.0.113.9:22 Abc12345"]],
    // Without a name to sign in as, it is root.
    ["vps 203.0.113.9 pass Rahasia#123", ["server root@203.0.113.9:22 Rahasia#123"]],
  ]);
});

test("a server, as it is written in Indonesian", () => {
  each([
    ["server saya 203.0.113.9, usernya ubuntu, passwordnya Kucing#Oren9", ["server ubuntu@203.0.113.9:22 Kucing#Oren9"]],
    ["Masuk sebagai deploy di 203.0.113.9, kata sandinya Sandi#Kuat9.", ["server deploy@203.0.113.9:22 Sandi#Kuat9"]],
    ["vps 203.0.113.9 root, password ssh: Rahasia#1", ["server root@203.0.113.9:22 Rahasia#1"]],
    ["password root vps: Rahasia#1 ip 203.0.113.9", ["server root@203.0.113.9:22 Rahasia#1"]],
  ]);
});

test("a server with a private key, and the passphrase of the key", () => {
  each([
    [`ini kunci vps 203.0.113.9 user ubuntu\n${KEY}`, ["server ubuntu@203.0.113.9:22 key"]],
    [`host: srv.example.com\nuser: deploy\npassphrase: frasa-Rahasia1\n${KEY}`, ["server deploy@srv.example.com:22 key+frasa-Rahasia1"]],
  ]);
  const text = `host: srv.example.com\nuser: deploy\npassphrase: frasa-Rahasia1\n${KEY}`;
  assert.equal(struck(text), "host: srv.example.com\nuser: deploy\npassphrase: [passphrase]\n[private key]");
  // A key that no machine is named with opens nothing that is known.
  assert.deepEqual(findAccess(`ini kunci saya\n${KEY}`), []);
});

test("the address, root and its password in a row, without a word that says so", () => {
  each([
    ["vps 203.0.113.9 root Rahasia#123", ["server root@203.0.113.9:22 Rahasia#123"]],
    ["203.0.113.9 root Abc123xyz", ["server root@203.0.113.9:22 Abc123xyz"]],
    ["203.0.113.9:2222 root Rahasia#123, tolong cek", ["server root@203.0.113.9:2222 Rahasia#123"]],
    ["vps 1: 203.0.113.9 root Satu#1111\nvps 2: 203.0.113.10 root Dua#2222", ["server root@203.0.113.9:22 Satu#1111", "server root@203.0.113.10:22 Dua#2222"]],
    // What follows "root" is a word of a sentence, a path, an address.
    ["ping 203.0.113.9 root cause unknown", []],
    ["203.0.113.9 root /var/www/html", []],
    ["di 203.0.113.9 root filesystem penuh 95%", []],
    ["cek 203.0.113.9 root 10.0.0.1", []],
  ]);
});

test("several machines in one message: each password with what its line names", () => {
  each([
    ["VPS A: 203.0.113.9 root pass Satu#1111\nVPS B: 203.0.113.10 root pass Dua#2222", ["server root@203.0.113.9:22 Satu#1111", "server root@203.0.113.10:22 Dua#2222"]],
    [
      "Server lama\nIP: 203.0.113.9\nUser: root\nPass: Satu#1111\n\nServer baru\nIP: 203.0.113.10\nUser: ubuntu\nPass: Dua#2222",
      ["server root@203.0.113.9:22 Satu#1111", "server ubuntu@203.0.113.10:22 Dua#2222"],
    ],
  ]);
});

test("a site: a web address, a name and a password", () => {
  each([
    ["login ke https://panel.example.com/login\nusername: budi\npassword: rahasia-budi-123", ["site budi at https://panel.example.com/login rahasia-budi-123"]],
    ["akun wordpress: example.com/wp-admin user admin pass WpAdmin#2024", ["site admin at https://example.com/wp-admin WpAdmin#2024"]],
    ["email: budi@example.com password: Email#Pass1 untuk https://mail.example.com", ["site budi@example.com at https://mail.example.com Email#Pass1"]],
    ["cpanel https://example.com:2083 user exampleuser pass Cp@nel#1", ["site exampleuser at https://example.com:2083 Cp@nel#1"]],
    ["http://203.0.113.9:8080/login user admin pass Panel#123", ["site admin at http://203.0.113.9:8080/login Panel#123"]],
  ]);
});

test("a page on a machine that has a number and no name is a site, unless the text says a machine", () => {
  each([
    ["panel pterodactyl di 203.0.113.9 user admin pass Panel#123", ["site admin at http://203.0.113.9 Panel#123"]],
    ["panel 203.0.113.9:8080 user admin pass Panel#123", ["site admin at http://203.0.113.9:8080 Panel#123"]],
    ["aapanel 203.0.113.9 port 8888 username admin password Panel#123", ["site admin at http://203.0.113.9:8888 Panel#123"]],
    ["panel di vps 203.0.113.9 user root pass Panel#123", ["server root@203.0.113.9:22 Panel#123"]],
    // The password is not what says so: "Panel#123" does not make the machine a panel.
    ["login 203.0.113.9 user admin pass Panel#123", ["server admin@203.0.113.9:22 Panel#123"]],
    ["203.0.113.9 user deploy pass Root#Vps99", ["server deploy@203.0.113.9:22 Root#Vps99"]],
  ]);
});

test("the password of a database, FTP or a mailbox is kept as a key, not tried as a sign-in", () => {
  each([
    ["db mysql: host 203.0.113.9 user app password Db#Pass99", ['key "mysql password" Db#Pass99 -> no site']],
    ["MYSQL_PASSWORD=Db#Pass99", ['key "mysql password" Db#Pass99 -> no site']],
    ["MYSQL_ROOT_PASSWORD: Db#Pass99", ['key "mysql password" Db#Pass99 -> no site']],
    ["database: toko\nhost: 203.0.113.9\nuser: app\npassword: Db#Pass99", ['key "database password" Db#Pass99 -> no site']],
    ["akun ftp: 203.0.113.9 user web pass Ftp#Pass1", ['key "ftp password" Ftp#Pass1 -> no site']],
    ["ftp 203.0.113.9 user web pass Ftp#Pass1", ['key "ftp password" Ftp#Pass1 -> no site']],
    ["password mysql: Db#Pass99, usernya app", ['key "mysql password" Db#Pass99 -> no site']],
    ["smtp host mail.example.com user noreply@example.com password Smtp#Pass1", ['key "smtp password" Smtp#Pass1 -> no site']],
    ["redis password: Rd#Pass12345", ['key "redis password" Rd#Pass12345 -> no site']],
  ]);
  assert.equal(struck("db mysql: host 203.0.113.9 user app password Db#Pass99"), "db mysql: host 203.0.113.9 user app password [password]");
});

test("a service that is only spoken of says nothing about the password", () => {
  each([
    ["IP: 203.0.113.9\nUser: deploy\nPass: Rahasia#123\ntolong install mysql", ["server deploy@203.0.113.9:22 Rahasia#123"]],
    ["tolong install mysql di IP 203.0.113.9 user deploy pass Rahasia#123", ["server deploy@203.0.113.9:22 Rahasia#123"]],
    ["vps ku 203.0.113.9 root pass Rahasia#123, di situ ada mysql dan ftp", ["server root@203.0.113.9:22 Rahasia#123"]],
    ["ssh deploy@203.0.113.9 password Rahasia#123 lalu backup database", ["server deploy@203.0.113.9:22 Rahasia#123"]],
    ["server: 203.0.113.9\nuser: deploy\npassword: Satu#1111\n\nTolong backup database: toko_db ke folder backup", ["server deploy@203.0.113.9:22 Satu#1111"]],
  ]);
});

test("a machine and what runs on it, in one message", () => {
  each([
    ["vps 203.0.113.9 root pass Satu#1111\nmysql: user app pass Dua#2222", ["server root@203.0.113.9:22 Satu#1111", 'key "mysql password" Dua#2222 -> no site']],
    ["vps 203.0.113.9 root pass Satu#1111\n\nmysql: user app pass Dua#2222", ["server root@203.0.113.9:22 Satu#1111", 'key "mysql password" Dua#2222 -> no site']],
    ["IP: 203.0.113.9\nUser: root\nPass: Satu#1111\nMySQL user: app\nMySQL pass: Dua#2222", ["server root@203.0.113.9:22 Satu#1111", 'key "mysql password" Dua#2222 -> no site']],
  ]);
});

test("a key: what is called one, and what has the shape of one", () => {
  each([
    [`token discord bot: ${DISCORD}`, [`key "Discord bot token" ${DISCORD} -> discord.com`]],
    [`pakai ini buat push: ${GITHUB}`, [`key "GitHub token" ${GITHUB} -> github.com`]],
    ["API_KEY=zx81-untied-0123456789abcdef", ['key "API key" zx81-untied-0123456789abcdef -> no site']],
    ["token api toko: tk_live_9f8e7d6c5b4a39281706XYZ untuk https://toko.example.com", ['key "token api toko" tk_live_9f8e7d6c5b4a39281706XYZ -> toko.example.com']],
    ["Authorization: Bearer abcdef0123456789abcdef0123456789 ke api.toko.example.com", ['key "API key" abcdef0123456789abcdef0123456789 -> api.toko.example.com']],
    [`bot telegram ${TELEGRAM}`, [`key "Telegram bot token" ${TELEGRAM} -> api.telegram.org`]],
    [`pterodactyl api key ${PTERODACTYL} di panel.example.com`, [`key "Pterodactyl API key" ${PTERODACTYL} -> panel.example.com`]],
  ]);
});

test("a key is of the service its setting is named after", () => {
  each([
    [`OPENAI_API_KEY=${OPENAI}`, [`key "OpenAI API key" ${OPENAI} -> openai.com`]],
    ["DISCORD_TOKEN=abcdefghijklmnop0123456789abcdef", ['key "Discord token" abcdefghijklmnop0123456789abcdef -> discord.com']],
    ["CLOUDFLARE_API_TOKEN: abcdefghijklmnop0123456789abcdefABCD", ['key "Cloudflare token" abcdefghijklmnop0123456789abcdefABCD -> cloudflare.com']],
    [`${PLAIN_SK} buat openrouter`, [`key "OpenRouter API key" ${PLAIN_SK} -> openrouter.ai`]],
  ]);
});

test("what hands nothing over stays as it was written", () => {
  for (const text of [
    "Aku lupa password wifi rumah, gimana cara reset password di ubuntu? user baru bisa login?",
    // A password that comes with nothing it opens.
    "password: Rahasia#123",
    "tolong cek 203.0.113.9 kenapa lambat",
    "kirim email ke budi@example.com soal password yang lupa",
    "Bagaimana cara membuat token API di Cloudflare?",
    "",
  ]) {
    assert.deepEqual(findAccess(text), [], text);
    assert.equal(struck(text), text);
  }
  // Longer than a message can be: not looked through.
  assert.deepEqual(findAccess(`vps 203.0.113.9 root pass Rahasia#123 ${"x".repeat(64_000)}`), []);
});

test("the secrets are struck where they stand, and nothing else", () => {
  assert.equal(struck("ini vps ku\nIP: 103.150.60.19\nUser: root\nPass: Rahasia#123\ntolong cek disk"), "ini vps ku\nIP: 103.150.60.19\nUser: root\nPass: [password]\ntolong cek disk");
  assert.equal(struck('{"host": "203.0.113.9", "username": "root", "password": "p@ss,w0rd"}'), '{"host": "203.0.113.9", "username": "root", "password": "[password]"}');
  assert.equal(struck("VPS 203.0.113.9 user deploy pass Abc123!x, tolong restart nginx"), "VPS 203.0.113.9 user deploy pass [password], tolong restart nginx");
  assert.equal(struck("token api toko: tk_live_9f8e7d6c5b4a39281706XYZ untuk https://toko.example.com"), "token api toko: [key] untuk https://toko.example.com");
  assert.equal(struck("Masuk sebagai deploy di 203.0.113.9, kata sandinya Sandi#Kuat9."), "Masuk sebagai deploy di 203.0.113.9, kata sandinya [password].");
});

test("what the app wrote where a secret stood is nobody's password", () => {
  const kept: Kept = { kind: "server", name: "vps-203-0-113-9", where: "root@203.0.113.9:22", ok: true, updated: false, note: "" };
  const notKept: Kept = { ...kept, name: "", ok: false };
  const marks = [
    markFor("password", kept),
    markFor("password", notKept),
    markFor("private key", kept),
    markFor("passphrase", kept),
    markFor("key", { ...kept, kind: "key", name: "token-api-toko" }),
    markFor("password", { ...kept, name: "panel.example.com" }),
    "[kept by the app]",
    "[not kept in a note]",
    keyMark("server-pass"),
  ];
  for (const mark of marks) {
    assert.deepEqual(appMarks(`pass ${mark} lalu`), [{ start: 5, end: 5 + mark.length }], mark);
    for (const text of [
      `VPS 203.0.113.9 user root pass ${mark} tolong cek`,
      `IP: 203.0.113.9\nPort: 22\nUser: root\nPass: ${mark}`,
      `ssh root@203.0.113.9 password ${mark}`,
      `login https://toko.example.com/login user budi password ${mark}`,
      `API_KEY=${mark}`,
      `token api toko: ${mark} untuk https://toko.example.com`,
      `203.0.113.9 root ${mark}`,
      JSON.stringify({ host: "203.0.113.9", user: "root", password: mark }),
    ]) {
      assert.deepEqual(findAccess(text), [], text);
    }
  }
  // A goal that is saved again with its mark, and something new beside it.
  assert.deepEqual(summary(findAccess(`VPS 203.0.113.9 user root pass ${marks[0]}\nVPS kedua 203.0.113.10 user root pass Baru#Sandi-22`)), ["server root@203.0.113.10:22 Baru#Sandi-22"]);
  // What only looks like a mark is a password as any other.
  assert.deepEqual(summary(findAccess("VPS 203.0.113.9 user root pass [Kurung]Sandi9")), ["server root@203.0.113.9:22 [Kurung]Sandi9"]);
});

test("hosts and addresses", () => {
  assert.equal(isIpv4("203.0.113.9"), true);
  assert.equal(isIpv4("256.0.113.9"), false);
  assert.equal(isIpv4("203.0.113"), false);
  assert.equal(isHost("srv1.example.com"), true);
  assert.equal(isHost("203.0.113.9"), true);
  // A file is not a machine, and a word is not a full name.
  assert.equal(isHost("notes.txt"), false);
  assert.equal(isHost("index.php"), false);
  assert.equal(isHost("localhost"), false);
  assert.equal(isHost("example"), false);
});

test("replaceSpans replaces parts that do not overlap, in their order", () => {
  assert.equal(replaceSpans("abcdef", [{ start: 4, end: 6, with: "Z" }, { start: 0, end: 2, with: "X" }]), "XcdZ");
  // A part that overlaps the one before it is left.
  assert.equal(replaceSpans("abcdef", [{ start: 0, end: 3, with: "X" }, { start: 2, end: 4, with: "Y" }]), "Xdef");
  assert.equal(replaceSpans("abc", []), "abc");
});
