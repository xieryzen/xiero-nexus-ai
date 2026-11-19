#!/usr/bin/env node
// A machine to sign in to over SSH, for the end-to-end checks: a real SSH
// server (the one of the ssh2 package) on this machine, that runs what it is
// told with `sh` in a folder of its own.
//
//   node scripts/e2e/mock-ssh.mjs <ssh port> <control port>
//
// It listens on 127.0.0.1 only, and takes two accounts:
//
//   root    with the password "mock-ssh-password" (the control changes it)
//   deploy  with a key: the private half is handed out by the control, plain
//           and with a passphrase
//
// The control is plain HTTP, for the checks:
//
//   GET  /__state               what happened: connections, commands, sign-ins,
//                               the host key and the keys of "deploy"
//   GET  /__reset               forget what happened (the counts and the lists)
//   GET  /__drop                cut every open connection, as a network does
//   GET  /__rekey               show another host key from now on, as a machine
//                               that was set up again does
//   GET  /__password?value=…    the password "root" signs in with
//   GET  /__listen?on=0|1       stop answering on the SSH port, or answer again
//   GET  /__idle?seconds=N      cut a connection that sent nothing for N seconds
//                               (0: never), as a firewall in between does
//   GET  /__sessions?max=N      open at most N sessions on a connection at a time
//                               (0: no limit), as MaxSessions does
//   GET  /__shell?on=0|1        answer a command as a machine without a shell
//                               does (the command line of a router), or run it
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");

const HOST = "127.0.0.1";
const sshPort = Number(process.argv[2] ?? 4012);
const controlPort = Number(process.argv[3] ?? 4013);

const home = mkdtempSync(join(tmpdir(), "xiero-mock-ssh-"));
const PASSPHRASE = "mock-key-passphrase";

/** The keys of the account "deploy": one without a passphrase and one with. */
const plainKey = utils.generateKeyPairSync("ed25519");
const sealedKey = utils.generateKeyPairSync("ed25519", { passphrase: PASSPHRASE, cipher: "aes256-ctr" });
const accepted = [utils.parseKey(plainKey.public), utils.parseKey(sealedKey.public)];

const state = {
  password: "mock-ssh-password",
  hostKey: utils.generateKeyPairSync("ed25519"),
  /** Connections that got as far as the SSH handshake, ever. */
  connections: 0,
  /** Sign-ins that were accepted, and refused. */
  signIns: 0,
  refused: 0,
  /** What signed in last: "password" or "publickey". */
  method: null,
  /** Every command line as it arrived. */
  lines: [],
  /** The same without the wrapper the app puts around a command. */
  commands: [],
  /** Processes started for commands that are still running. */
  running: 0,
  /** Connections cut because they said nothing for too long. */
  idleCuts: 0,
  idleSeconds: 0,
  maxSessions: 0,
  /** Session requests that were turned down because of the limit. */
  sessionsRefused: 0,
  /** Signals that came in through a command's own channel. */
  signals: [],
  /** Whether a command is run by a shell. Off: it is answered as a machine without one answers. */
  shell: true,
};
const sockets = new Set();
const clients = new Set();

function publicLine(pair) {
  const key = utils.parseKey(pair.public);
  return `${key.type} ${key.getPublicSSH().toString("base64")}`;
}

function fingerprint(pair) {
  return `SHA256:${createHash("sha256").update(utils.parseKey(pair.public).getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

/** The command inside the app's wrapper: sh -c '<how to run>' '<the command>'. */
function inner(line) {
  const match = /^sh -c '(?:[^']|'\\'')*' '((?:[^']|'\\'')*)'$/s.exec(line);
  return match ? match[1].replace(/'\\''/g, "'") : line;
}

function serve(client) {
  state.connections++;
  clients.add(client);
  let sessions = 0;
  client.on("close", () => clients.delete(client));
  client.on("error", () => undefined);
  client.on("authentication", (ctx) => {
    const ok = () => {
      state.signIns++;
      state.method = ctx.method;
      ctx.accept();
    };
    if (ctx.method === "password" && ctx.username === "root" && ctx.password === state.password) return ok();
    if (ctx.method === "publickey" && ctx.username === "deploy") {
      const key = accepted.find((k) => ctx.key.algo === k.type && Buffer.compare(ctx.key.data, k.getPublicSSH()) === 0);
      if (key && (!ctx.signature || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) {
        // Without a signature the client only asks whether the key would do.
        return ctx.signature ? ok() : ctx.accept();
      }
    }
    if (ctx.method !== "none") state.refused++;
    ctx.reject(["password", "publickey"]);
  });
  client.on("ready", () => {
    client.on("session", (accept, reject) => {
      if (state.maxSessions > 0 && sessions >= state.maxSessions) {
        state.sessionsRefused++;
        reject();
        return;
      }
      sessions++;
      const session = accept();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        sessions--;
      };
      session.on("close", release);
      let child = null;
      // A signal for the command, as an SSH server of the last years passes it on: to the command and what it started.
      session.on("signal", (acceptSignal, _rejectSignal, info) => {
        state.signals.push(info.name);
        try {
          if (child?.pid) process.kill(-child.pid, `SIG${info.name}`);
        } catch {
          // Already over.
        }
        acceptSignal?.();
      });
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        state.lines.push(info.command);
        if (!state.shell) {
          // As a machine that signs in to something else than a shell: the
          // command line of a router answers a line it does not know.
          stream.stderr.write("bad command name sh (line 1 column 1)\r\n");
          stream.exit(1);
          stream.end();
          return;
        }
        state.commands.push(inner(info.command));
        state.running++;
        // Its own process group, as a machine gives a command: ending the group ends what it started.
        child = spawn("sh", ["-c", info.command], { cwd: home, env: { ...process.env, HOME: home }, detached: true });
        child.stdout.on("data", (data) => stream.write(data));
        child.stderr.on("data", (data) => stream.stderr.write(data));
        stream.on("data", (data) => child.stdin.write(data));
        stream.on("end", () => child.stdin.end());
        child.stdin.on("error", () => undefined);
        child.on("error", () => undefined);
        child.on("close", (code, signal) => {
          state.running--;
          release();
          try {
            stream.exit(signal ?? code ?? 0);
            stream.end();
          } catch {
            // The connection is gone.
          }
        });
      });
    });
  });
}

let ssh = new Server({ hostKeys: [state.hostKey.private] }, serve);

// The sockets are accepted here and handed to the SSH server, so that this
// script sees when one last sent something.
const listener = net.createServer((socket) => {
  sockets.add(socket);
  socket.lastHeard = Date.now();
  socket.on("data", () => {
    socket.lastHeard = Date.now();
  });
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  ssh.injectSocket(socket);
});
let listening = false;
function listen(on) {
  return new Promise((resolve) => {
    if (on === listening) return resolve();
    listening = on;
    if (on) listener.listen(sshPort, HOST, resolve);
    else {
      for (const socket of sockets) socket.destroy();
      listener.close(() => resolve());
    }
  });
}

setInterval(() => {
  if (state.idleSeconds <= 0) return;
  const now = Date.now();
  for (const socket of sockets) {
    if (now - socket.lastHeard > state.idleSeconds * 1000) {
      state.idleCuts++;
      socket.destroy();
    }
  }
}, 250).unref();

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const number = (name) => Math.max(0, Number(url.searchParams.get(name)) || 0);
  switch (url.pathname) {
    case "/__state":
      return send(res, 200, {
        port: sshPort,
        listening,
        connections: state.connections,
        open: clients.size,
        signIns: state.signIns,
        refused: state.refused,
        method: state.method,
        lines: state.lines,
        commands: state.commands,
        running: state.running,
        idleCuts: state.idleCuts,
        sessionsRefused: state.sessionsRefused,
        signals: state.signals,
        hostKey: publicLine(state.hostKey),
        fingerprint: fingerprint(state.hostKey),
        password: state.password,
        key: plainKey.private,
        sealedKey: sealedKey.private,
        passphrase: PASSPHRASE,
        publicKey: plainKey.public,
        home,
      });
    case "/__reset":
      Object.assign(state, { connections: 0, signIns: 0, refused: 0, method: null, lines: [], commands: [], idleCuts: 0, sessionsRefused: 0, signals: [] });
      return send(res, 200, { ok: true });
    case "/__drop": {
      const cut = sockets.size;
      for (const socket of sockets) socket.destroy();
      return send(res, 200, { ok: true, cut });
    }
    case "/__rekey":
      state.hostKey = utils.generateKeyPairSync("ed25519");
      ssh = new Server({ hostKeys: [state.hostKey.private] }, serve);
      for (const socket of sockets) socket.destroy();
      return send(res, 200, { ok: true, hostKey: publicLine(state.hostKey), fingerprint: fingerprint(state.hostKey) });
    case "/__password":
      state.password = url.searchParams.get("value") || "mock-ssh-password";
      return send(res, 200, { ok: true });
    case "/__listen":
      await listen(url.searchParams.get("on") !== "0");
      return send(res, 200, { ok: true, listening });
    case "/__idle":
      state.idleSeconds = number("seconds");
      return send(res, 200, { ok: true, idleSeconds: state.idleSeconds });
    case "/__sessions":
      state.maxSessions = number("max");
      return send(res, 200, { ok: true, maxSessions: state.maxSessions });
    case "/__shell":
      state.shell = url.searchParams.get("on") !== "0";
      return send(res, 200, { ok: true, shell: state.shell });
    default:
      return send(res, 404, { error: "not found" });
  }
});

function end() {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Left for the system to clear.
  }
  process.exit(0);
}
process.on("SIGINT", end);
process.on("SIGTERM", end);

await listen(true);
control.listen(controlPort, HOST, () => {
  console.log(`mock ssh: ${HOST}:${sshPort}, control http://${HOST}:${controlPort}, home ${home}`);
});
