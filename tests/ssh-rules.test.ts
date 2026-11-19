import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  COMMAND_MAX_CHARS,
  DEFAULT_TIMEOUT_SECONDS,
  LOG_OUTPUT_CHARS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  OutputBuffer,
  PID_MARK,
  SERVERS_PER_PROJECT,
  SERVER_TOOL,
  cleanOutput,
  clipMiddle,
  clipStart,
  commandLabel,
  earlierNote,
  hostForConnection,
  hostProblem,
  killCommand,
  logOutput,
  looksLikePrivateKey,
  managesServers,
  mayUseServer,
  outcomeLine,
  portOf,
  remoteCommand,
  resultText,
  serverName,
  serversLine,
  shellQuote,
  takePid,
  timeoutSeconds,
  took,
  toolDescription,
  usernameProblem,
  type CommandResult,
} from "../src/lib/ssh/rules";
import { fingerprint, hostKeyFile, hostKeyLine, normalizeHostKey, parseHostKey, sameHostKey } from "../src/lib/ssh/host-key";
import { TOOL_CATALOG, TOOL_GROUP_LABELS, isToolName } from "../src/lib/agent/catalog";

// ─── Who ─────────────────────────────────────────────────────────────────────

test("only an owner manages servers; a user's projects never work on one", () => {
  assert.equal(managesServers("owner"), true);
  for (const role of ["admin", "user", "", null, undefined]) assert.equal(managesServers(role), false, String(role));

  assert.equal(mayUseServer("owner", "owners"), true);
  assert.equal(mayUseServer("owner", "admins"), true);
  assert.equal(mayUseServer("admin", "admins"), true);
  assert.equal(mayUseServer("admin", "owners"), false);
  for (const access of ["owners", "admins", "everyone", ""]) {
    assert.equal(mayUseServer("user", access), false, access);
    assert.equal(mayUseServer(null, access), false, access);
    assert.equal(mayUseServer(undefined, access), false, access);
  }
  // A word that is no access: nobody but an owner.
  assert.equal(mayUseServer("admin", "everyone"), false);
});

test("the tool is in the catalog, in a group of its own", () => {
  assert.equal(SERVER_TOOL, "run_on_server");
  assert.equal(isToolName(SERVER_TOOL), true);
  const tool = TOOL_CATALOG.find((t) => t.name === SERVER_TOOL);
  assert.equal(tool?.group, "servers");
  assert.equal(TOOL_GROUP_LABELS.servers, "Servers over SSH");
  // It needs nothing of the installation: what it needs is a project that names a machine.
  assert.equal(tool?.needs, undefined);
  assert.match(tool?.inProjects ?? "", /names a server/);
});

// ─── What is registered ──────────────────────────────────────────────────────

test("a server's name is kept in lower case, and is letters, digits, dots, dashes and underscores", () => {
  assert.equal(serverName(" VPS-Jakarta.1 "), "vps-jakarta.1");
  assert.equal(serverName("node_2"), "node_2");
  assert.equal(serverName("9"), "9");
  for (const bad of ["", " ", "my server", "-first", ".hidden", "a/b", "vps;rm", "naïve", "x".repeat(41)]) {
    assert.equal(serverName(bad), null, JSON.stringify(bad));
  }
  assert.equal(serverName("x".repeat(40))?.length, 40);
});

test("a host is a name or an address, and nothing around it", () => {
  for (const good of ["example.com", "vps-1.example.co.id", "203.0.113.10", "localhost", "::1", "2001:db8::1", "[2001:db8::1]", "a"]) {
    assert.equal(hostProblem(good), null, good);
  }
  assert.match(hostProblem("") ?? "", /name or address/);
  assert.match(hostProblem("ssh://example.com") ?? "", /without "ssh:\/\/"/);
  assert.match(hostProblem("root@example.com") ?? "", /Username/);
  assert.match(hostProblem("example.com:22") ?? "", /Port/);
  assert.match(hostProblem("203.0.113.10:2222") ?? "", /Port/);
  assert.match(hostProblem("my host") ?? "", /no spaces/);
  for (const bad of ["-x.example.com", "example.com/path", "exa_mple.com", "a".repeat(254)]) {
    assert.notEqual(hostProblem(bad), null, bad);
  }
  assert.equal(hostForConnection(" [2001:db8::1] "), "2001:db8::1");
  assert.equal(hostForConnection("example.com"), "example.com");
});

test("an account name and a port", () => {
  for (const good of ["root", "deploy", "ubuntu", "svc_app", "first.last", "a-b", "machine$"]) assert.equal(usernameProblem(good), null, good);
  for (const bad of ["", "two words", "-flag", "a;b", "a`b", "x".repeat(65)]) assert.notEqual(usernameProblem(bad), null, JSON.stringify(bad));
  assert.equal(portOf(22), 22);
  assert.equal(portOf("2222"), 2222);
  for (const bad of [0, 65536, 2.5, "x", "", null, undefined, -1]) assert.equal(portOf(bad), null, String(bad));
});

test("a private key is told from its public half", () => {
  assert.equal(looksLikePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----"), true);
  assert.equal(looksLikePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n"), true);
  assert.equal(looksLikePrivateKey("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"), true);
  assert.equal(looksLikePrivateKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGWX user@host"), false);
  assert.equal(looksLikePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----"), false);
  assert.equal(looksLikePrivateKey(""), false);
});

// ─── Host keys ───────────────────────────────────────────────────────────────

/** A real ed25519 host key, as a machine shows it: the blob of the SSH protocol. */
function ed25519Blob(): Buffer {
  const raw = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
  return Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]);
}

test("a host key is kept as the line OpenSSH writes, and its fingerprint is the one ssh-keygen prints", () => {
  const blob = ed25519Blob();
  const line = hostKeyLine(blob);
  assert.equal(line, `ssh-ed25519 ${blob.toString("base64")}`);
  assert.equal(fingerprint(line!), `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`);
  assert.match(fingerprint(line!)!, /^SHA256:[A-Za-z0-9+/]{43}$/);

  // As a known_hosts line, and with a comment: the same key.
  assert.equal(normalizeHostKey(`[203.0.113.10]:2222 ${line}`), line);
  assert.equal(normalizeHostKey(`${line} root@vps`), line);
  assert.equal(sameHostKey(line!, `vps.example.com ${line} comment`), true);
  assert.equal(sameHostKey(line!, hostKeyLine(ed25519Blob())!), false);
  assert.deepEqual(parseHostKey(line!), { type: "ssh-ed25519", blob });
});

test("what is not a host key is not taken for one", () => {
  assert.equal(hostKeyLine(Buffer.from("not a key at all")), null);
  assert.equal(hostKeyLine(Buffer.alloc(0)), null);
  assert.equal(parseHostKey(""), null);
  assert.equal(parseHostKey("hello world"), null);
  assert.equal(parseHostKey("ssh-ed25519"), null);
  assert.equal(parseHostKey("ssh-ed25519 not*base64"), null);
  // A line whose type and whose key disagree.
  const rsaNamed = `ssh-rsa ${ed25519Blob().toString("base64")}`;
  assert.equal(parseHostKey(rsaNamed), null);
  assert.equal(fingerprint("nothing"), null);
  assert.equal(sameHostKey("nothing", "nothing"), false);
});

test("the file that holds a host key on the machine", () => {
  assert.equal(hostKeyFile("ssh-ed25519"), "/etc/ssh/ssh_host_ed25519_key.pub");
  assert.equal(hostKeyFile("ecdsa-sha2-nistp256"), "/etc/ssh/ssh_host_ecdsa_key.pub");
  assert.equal(hostKeyFile("ssh-rsa"), "/etc/ssh/ssh_host_rsa_key.pub");
});

// ─── A command ───────────────────────────────────────────────────────────────

/** Run a line the way a machine does for an account whose shell is `shell`. */
function onMachine(line: string, shell = "sh", typed?: string) {
  const run = spawnSync(shell, ["-c", line], { encoding: "utf8", ...(typed === undefined ? {} : { input: typed }) });
  const said = takePid(run.stderr);
  return { status: run.status, stdout: run.stdout, stderr: said.stderr, pid: said.pid };
}

test("a command is quoted so that the machine gets it as it was written", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const tricky = `echo "it's" 'a "quoted" $HOME' \\n \`date\` $(id) ; echo done`;
  const out = onMachine(`printf '%s' ${shellQuote(tricky)}`);
  assert.equal(out.stdout, tricky);
});

test("the line for a command runs it with bash where there is one, says which processes are its own, and asks nothing", () => {
  const plain = onMachine(remoteCommand("echo out; echo err >&2; exit 4"));
  assert.deepEqual([plain.status, plain.stdout, plain.stderr], [4, "out\n", "err\n"]);
  assert.ok(plain.pid !== null && plain.pid > 1, String(plain.pid));

  // Several lines, quotes of both kinds, and a here-document, as an agent writes a file.
  const file = onMachine(remoteCommand(`cat <<'EOF'\nline 'one' "two"\n  $not_expanded \\ back\nEOF\necho after`));
  assert.equal(file.stdout, `line 'one' "two"\n  $not_expanded \\ back\nafter\n`);

  // Nobody is at a keyboard: reading gets nothing, also when something is
  // typed at the connection, and package tools are told not to ask.
  const asks = onMachine(remoteCommand('if read answer; then echo "got $answer"; else echo no-input; fi; echo "$DEBIAN_FRONTEND"'), "sh", "typed by someone\n");
  assert.equal(asks.stdout, "no-input\nnoninteractive\n");
  // What a command hands on itself still arrives: a pipe, a here-document.
  const piped = onMachine(remoteCommand("echo handed-on | (read line; echo \"got $line\")"), "sh", "typed by someone\n");
  assert.equal(piped.stdout, "got handed-on\n");

  // What only bash knows works when the machine has bash, whatever shell the account signs in with.
  if (spawnSync("bash", ["-c", "true"]).status === 0) {
    const bashism = onMachine(remoteCommand('[[ "abc" == a* ]] && echo yes; x=(1 2 3); echo ${#x[@]}'), "sh");
    assert.equal(bashism.stdout, "yes\n3\n");
  }
});

test("the processes of a command are told from what it printed, also when the line comes in pieces", () => {
  assert.deepEqual(takePid(`${PID_MARK}4321\n`), { pid: 4321, stderr: "" });
  assert.deepEqual(takePid(`${PID_MARK}4321\nreal error\n`), { pid: 4321, stderr: "real error\n" });
  // A shell that prints something of its own first.
  assert.deepEqual(takePid(`motd\n${PID_MARK}77\nreal error\n`), { pid: 77, stderr: "motd\nreal error\n" });
  // Half a line: not yet, while more is coming; all there is, once it is over.
  assert.deepEqual(takePid(`${PID_MARK}43`, false), { pid: null, stderr: `${PID_MARK}43` });
  assert.deepEqual(takePid(`${PID_MARK}43`), { pid: 43, stderr: "" });
  assert.deepEqual(takePid(`${PID_MARK}43\n`, false), { pid: 43, stderr: "" });
  // Not at the start of a line: it is something the command printed.
  assert.deepEqual(takePid(`echo ${PID_MARK}9\n`), { pid: null, stderr: `echo ${PID_MARK}9\n` });
  assert.deepEqual(takePid("nothing here"), { pid: null, stderr: "nothing here" });
  // 0 and 1 are never ended.
  assert.equal(takePid(`${PID_MARK}1\n`).pid, null);
  assert.equal(takePid(`${PID_MARK}0\n`).pid, null);
});

test("ending a command ends what it started, in every sh, and is over when nothing is left", () => {
  const line = killCommand(4321);
  assert.match(line, /^sh -c '/);
  assert.ok(line.includes("kill -TERM -4321") && line.includes("kill -KILL -4321") && line.includes("kill -0 -4321"));
  // dash refuses "--" before a negative number.
  assert.ok(!line.includes(" -- "));

  // For real: a command that starts something in the background, in a group of its own.
  const started = spawnSync("sh", ["-c", `setsid sh -c ${shellQuote(remoteCommand("sh -c 'sleep 47' & sleep 47"))} > /dev/null 2> /tmp/xn-ssh-rules-test.err & sleep 0.6; cat /tmp/xn-ssh-rules-test.err; rm -f /tmp/xn-ssh-rules-test.err`], { encoding: "utf8" });
  const group = takePid(started.stdout).pid;
  if (group === null) return; // No setsid here: the line itself is checked above.
  // What is in its group: the two sleeps among them, the one in the background too.
  const inGroup = (only = "") =>
    spawnSync("sh", ["-c", `ps -eo pgid,comm | awk '$1 == ${group}${only ? ` && $2 == "${only}"` : ""}' | wc -l`], { encoding: "utf8" }).stdout.trim();
  assert.equal(inGroup("sleep"), "2");
  const before = Date.now();
  assert.equal(spawnSync("sh", ["-c", killCommand(group)]).status, 0);
  assert.equal(inGroup(), "0");
  assert.ok(Date.now() - before < 1800, `it took ${Date.now() - before} ms`);
  // A group that is not there: over at once, and no error.
  assert.equal(spawnSync("sh", ["-c", killCommand(group)]).status, 0);
});

test("the time a command may take is what was asked, within the limits", () => {
  assert.equal(timeoutSeconds(undefined), DEFAULT_TIMEOUT_SECONDS);
  assert.equal(timeoutSeconds(null), DEFAULT_TIMEOUT_SECONDS);
  assert.equal(timeoutSeconds(""), DEFAULT_TIMEOUT_SECONDS);
  assert.equal(timeoutSeconds("soon"), DEFAULT_TIMEOUT_SECONDS);
  assert.equal(timeoutSeconds(60), 60);
  assert.equal(timeoutSeconds("90"), 90);
  assert.equal(timeoutSeconds(12.6), 13);
  assert.equal(timeoutSeconds(0), MIN_TIMEOUT_SECONDS);
  assert.equal(timeoutSeconds(-5), MIN_TIMEOUT_SECONDS);
  assert.equal(timeoutSeconds(1e9), MAX_TIMEOUT_SECONDS);
  assert.ok(MIN_TIMEOUT_SECONDS < DEFAULT_TIMEOUT_SECONDS && DEFAULT_TIMEOUT_SECONDS < MAX_TIMEOUT_SECONDS);
  assert.ok(COMMAND_MAX_CHARS >= 8000 && SERVERS_PER_PROJECT >= 1);
});

// ─── What a command printed ──────────────────────────────────────────────────

test("a stream of any length is kept by its start and its end", () => {
  const small = new OutputBuffer(10, 10);
  small.add(Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz"));
  small.add(Buffer.from("END"));
  assert.equal(small.text(), "0123456789\n[… 19 bytes in between were not kept …]\ntuvwxyzEND");
  assert.deepEqual([small.bytes, small.dropped], [39, 19]);

  const whole = new OutputBuffer(10, 10);
  whole.add(Buffer.from("0123456789"));
  whole.add(Buffer.from("abcdefghij"));
  assert.equal(whole.text(), "0123456789abcdefghij");
  assert.equal(whole.dropped, 0);

  // A megabyte in small pieces: what is held stays small.
  const big = new OutputBuffer();
  for (let i = 0; i < 16_384; i++) big.add(Buffer.from(`${String(i).padStart(7, "0")} ${"x".repeat(55)}\n`));
  assert.equal(big.bytes, 16_384 * 64);
  const text = big.text();
  assert.ok(text.length < 70_000, String(text.length));
  assert.ok(text.startsWith("0000000 ") && text.trimEnd().endsWith("x") && text.includes("0016383 "));
  assert.match(text, /\[… \d+ bytes in between were not kept …\]/);
  assert.equal(new OutputBuffer().text(), "");
});

test("what a program printed is read without the codes of a terminal", () => {
  assert.equal(cleanOutput("\u001b[32mgreen\u001b[0m and \u001b[1;31mred\u001b[m"), "green and red");
  assert.equal(cleanOutput("line one\r\nline two\r\n"), "line one\nline two\n");
  // A line that was rewritten in place shows what it showed last.
  assert.equal(cleanOutput("progress 10%\rprogress 50%\rprogress 100%\ndone"), "progress 100%\ndone");
  assert.equal(cleanOutput("\u001b]0;window title\u0007text"), "text");
  assert.equal(cleanOutput("bell\u0007 null\u0000 tab\there"), "bell null tab\there");
  assert.equal(cleanOutput("\u001b[2K\u001b[1Gnpm http fetch\u001b[?25l"), "npm http fetch");
  assert.equal(cleanOutput("plain text\n"), "plain text\n");
  assert.equal(cleanOutput(""), "");
});

test("a long text is cut in the middle, or at its start, and says by how much", () => {
  assert.equal(clipMiddle("short", { head: 10, tail: 10 }), "short");
  assert.equal(clipMiddle("a".repeat(10) + "b".repeat(30) + "c".repeat(10), { head: 10, tail: 10 }), `${"a".repeat(10)}\n[… 30 characters cut …]\n${"c".repeat(10)}`);
  assert.equal(clipStart("short", 10), "short");
  assert.equal(clipStart("0123456789abcde", 5), "[… 10 characters before this were cut]\nabcde");
  assert.equal(commandLabel("apt-get   update\n  && apt-get -y upgrade", 20), "apt-get update && a…");
  assert.equal(commandLabel("ls"), "ls");
});

const result = (over: Partial<CommandResult>): CommandResult => ({
  outcome: "ok",
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1200,
  timeoutSeconds: 300,
  ...over,
});

test("an agent reads how a command ended, and what it printed", () => {
  assert.equal(resultText("vps-1", result({ stdout: "hello\n", stderr: "" })), "[vps-1] exit code 0, 1.2 s\nstdout:\nhello\nstderr: (empty)");
  assert.equal(
    resultText("vps-1", result({ outcome: "failed", exitCode: 2, stdout: "", stderr: "\u001b[31mno such file\u001b[0m\n" })),
    "[vps-1] exit code 2, 1.2 s\nstdout: (empty)\nstderr:\nno such file",
  );
  assert.equal(outcomeLine("vps-1", result({ outcome: "failed", exitCode: null, signal: "SIGKILL" })), "[vps-1] ended by signal SIGKILL, 1.2 s");
  const timeout = outcomeLine("db", result({ outcome: "timeout", exitCode: null, durationMs: 5300, timeoutSeconds: 5, ended: true }));
  assert.match(timeout, /^\[db\] stopped: it was still running after the 5 s it was allowed \(timeout_seconds\)\. It was ended on the server\./);
  assert.match(timeout, /nohup/);
  assert.match(outcomeLine("db", result({ outcome: "timeout", exitCode: null, timeoutSeconds: 5, ended: false })), /could not be confirmed: look whether it still runs/);
  assert.equal(outcomeLine("db", result({ outcome: "cancelled", exitCode: null, durationMs: 42_000 })), "[db] stopped after 42 s: the run was stopped.");
  const lost = outcomeLine("db", result({ outcome: "lost", exitCode: null, durationMs: 200_000 }));
  assert.match(lost, /^\[db\] the connection was lost after 3 min 20 s, while the command ran\. Whether it finished is not known\./);
  assert.match(lost, /look at what is there before you repeat it/);

  // A long output: the start and the end of each stream, within what a tool result may hold.
  const long = resultText("vps-1", result({ stdout: `${"a".repeat(30_000)}\nLAST LINE`, stderr: `${"e".repeat(10_000)}\nLAST ERROR` }));
  assert.ok(long.length < 12_000, String(long.length));
  assert.ok(long.includes("LAST LINE") && long.includes("LAST ERROR") && /\[… \d+ characters cut …\]/.test(long));
});

test("how long something took, in words", () => {
  assert.equal(took(0), "0.0 s");
  assert.equal(took(432), "0.4 s");
  assert.equal(took(9_949), "9.9 s");
  assert.equal(took(10_000), "10 s");
  assert.equal(took(59_400), "59 s");
  assert.equal(took(60_000), "1 min");
  assert.equal(took(185_000), "3 min 5 s");
  assert.equal(took(3_600_000), "60 min");
});

test("the log keeps the end of what a command printed, both streams", () => {
  assert.equal(logOutput({ stdout: "one\n", stderr: "" }), "one");
  assert.equal(logOutput({ stdout: "", stderr: "problem\n" }), "stderr:\nproblem");
  assert.equal(logOutput({ stdout: "one\n", stderr: "problem\n" }), "one\nstderr:\nproblem");
  assert.equal(logOutput({ stdout: "", stderr: "" }), "");
  const long = logOutput({ stdout: `${"a".repeat(50_000)}END-OUT`, stderr: `${"e".repeat(50_000)}END-ERR` });
  assert.ok(long.length <= LOG_OUTPUT_CHARS + 200, String(long.length));
  assert.ok(long.includes("END-OUT") && long.includes("END-ERR"));
  // A short error stream leaves its room to the other one.
  const uneven = logOutput({ stdout: `${"a".repeat(50_000)}END-OUT`, stderr: "short" });
  assert.ok(uneven.length > LOG_OUTPUT_CHARS - 200 && uneven.endsWith("stderr:\nshort"));
});

// ─── What an agent is told ───────────────────────────────────────────────────

test("the tool names the machines of the project, the account, and the owner's notes; never where a machine is", () => {
  const servers = [
    { name: "vps-1", username: "root", notes: "Ubuntu 24.04,\n 4 GB. Leave /etc alone." },
    { name: "db", username: "deploy", notes: null },
  ];
  assert.equal(serversLine(servers), "vps-1 (signed in as root; Ubuntu 24.04, 4 GB. Leave /etc alone.); db (signed in as deploy)");
  const text = toolDescription(servers);
  assert.ok(text.endsWith(`Servers: ${serversLine(servers)}.`));
  for (const said of ["stays open for the whole run", "does not carry over", "Nobody is at a keyboard", "timeout_seconds", "nohup", "real machines"]) {
    assert.ok(text.includes(said), said);
  }
});

test("an attempt that starts over is told what the task already ran", () => {
  assert.equal(earlierNote([]), "");
  assert.equal(
    earlierNote([{ server: "vps-1", command: "apt-get update", status: "ok", exitCode: 0 }]),
    "(Before this attempt, this task already ran 1 command on the server:\n1. [vps-1] exit 0: apt-get update\nThey are not undone. Look at what is there before you repeat one.)",
  );
  const several = earlierNote([
    { server: "vps-1", command: "apt-get update", status: "ok", exitCode: 0 },
    { server: "vps-1", command: "false", status: "failed", exitCode: 1 },
    { server: "db", command: "sleep 99", status: "lost", exitCode: null },
    { server: "db", command: "echo x", status: "refused", exitCode: null },
    { server: "db", command: "make\n  install", status: "timeout", exitCode: null },
  ]);
  assert.ok(several.startsWith("(Before this attempt, this task already ran 5 commands on the server:\n"));
  assert.ok(several.includes("2. [vps-1] exit 1: false") && several.includes("3. [db] lost: sleep 99") && several.includes("4. [db] not started: echo x") && several.includes("5. [db] timeout: make install"));
  // Many: the last ones, and how many there were.
  const many = earlierNote(Array.from({ length: 50 }, (_, i) => ({ server: "vps-1", command: `step ${i + 1}`, status: "ok", exitCode: 0 })), 5);
  assert.ok(many.startsWith("(Before this attempt, this task already ran 50 commands on the server; the last 5:\n1. [vps-1] exit 0: step 46\n"));
  assert.ok(many.includes("5. [vps-1] exit 0: step 50") && !many.includes("step 45"));
});
