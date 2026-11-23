import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { servers, type Server, type User } from "@/db/schema";
import { AppError, Errors } from "../errors";
import { rateLimit } from "../ratelimit";
import { encryptSecret } from "../secrets";
import { fingerprint, normalizeHostKey } from "./host-key";
import { hostProblem, looksLikePrivateKey, serverName, usernameProblem, type ServerAccess } from "./rules";
import { credentialsOf } from "./servers";
import { SshProblem, checkServer, type Target } from "./sessions";

/**
 * Registering a machine, and changing one. What is registered has been seen
 * to work: the app signs in once, to the machine that shows the host key the
 * owner accepted, before anything is saved.
 */

/** Connections an owner may have the app open in a minute, by reading keys, registering and checking. */
export function limitConnections(user: Pick<User, "id">): void {
  const rate = rateLimit(`servers:${user.id}`, 30, 60_000);
  if (!rate.ok) throw Errors.rateLimited("Too many connections were asked for. Try again in a minute.");
}

/** What a request says about a machine. Everything is optional when a machine is changed. */
export interface ServerInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string | null;
  hostKey?: string;
  access?: ServerAccess;
  status?: "enabled" | "disabled";
  notes?: string | null;
}

/** An error about what the machine did, as a request is answered. */
export function problemError(problem: SshProblem): AppError {
  const code =
    problem.kind === "host_key"
      ? "host_key_mismatch"
      : problem.kind === "sign_in" || problem.kind === "key"
        ? "sign_in_refused"
        : problem.kind === "shell" || problem.kind === "busy"
          ? "command_not_run"
          : "server_unreachable";
  return new AppError(400, code, problem.message);
}

function nameFor(input: ServerInput, existing?: Server): string {
  if (input.name === undefined && existing) return existing.name;
  const name = serverName(input.name ?? "");
  if (!name) {
    throw Errors.badRequest('A name is lower-case letters, digits, ".", "_" and "-", and starts with a letter or a digit: vps-1.');
  }
  const taken = db
    .select({ id: servers.id })
    .from(servers)
    // Among the machines of the Servers page: what an account handed over in a conversation has names of its own.
    .where(existing ? and(eq(servers.name, name), isNull(servers.ownerId), ne(servers.id, existing.id)) : and(eq(servers.name, name), isNull(servers.ownerId)))
    .get();
  if (taken) throw Errors.conflict(`There is a server "${name}" already.`);
  return name;
}

export interface CheckedServer {
  /** The columns to write. */
  values: {
    name: string;
    host: string;
    port: number;
    username: string;
    authType: "password" | "key";
    secretCiphertext: string;
    passphraseCiphertext: string | null;
    hostKey: string;
    access: ServerAccess;
    status: "enabled" | "disabled";
    notes: string | null;
  };
  /** What the one command of the check printed, when the app signed in for this. */
  checked: string | null;
  /** Whether what signs in, or where, differs from what was registered. */
  connectionChanged: boolean;
}

/**
 * What a request asks to register, checked, and tried against the machine.
 * Throws a 400 that says what is wrong; nothing is saved by the caller then.
 */
export async function checkedServer(input: ServerInput, existing?: Server): Promise<CheckedServer> {
  const name = nameFor(input, existing);

  const host = (input.host ?? existing?.host ?? "").trim();
  const hostWrong = hostProblem(host);
  if (hostWrong) throw Errors.badRequest(hostWrong);
  const port = input.port ?? existing?.port ?? 22;
  const username = (input.username ?? existing?.username ?? "").trim();
  const userWrong = usernameProblem(username);
  if (userWrong) throw Errors.badRequest(userWrong);

  const authType = input.authType ?? existing?.authType;
  if (!authType) throw Errors.badRequest('Say how to sign in: "password" or "key".');
  const kept = existing && existing.authType === authType ? credentialsOf(existing) : {};
  let secret: string;
  let passphrase: string | null = null;
  if (authType === "password") {
    secret = input.password ?? kept.password ?? "";
    if (!secret) throw Errors.badRequest("Enter the password of the account.");
  } else {
    secret = (input.privateKey ?? kept.privateKey ?? "").trim();
    if (!secret) throw Errors.badRequest("Paste the private key.");
    if (!looksLikePrivateKey(secret)) {
      throw Errors.badRequest(
        'That is not a private key. It is the file without ".pub", and begins with "-----BEGIN OPENSSH PRIVATE KEY-----".',
      );
    }
    secret = `${secret}\n`;
    // A new key comes with its own passphrase, or with none.
    passphrase = input.passphrase !== undefined ? input.passphrase || null : input.privateKey ? null : (kept.passphrase ?? null);
  }

  const hostKey = normalizeHostKey(input.hostKey ?? existing?.hostKey ?? "");
  if (!hostKey) {
    throw Errors.badRequest(
      "The host key is missing. Read it from the machine first (POST /api/servers/host-key), compare it, and send it as hostKey.",
    );
  }

  const connectionChanged =
    !existing ||
    host !== existing.host ||
    port !== existing.port ||
    username !== existing.username ||
    authType !== existing.authType ||
    input.password !== undefined ||
    input.privateKey !== undefined ||
    input.passphrase !== undefined ||
    hostKey !== normalizeHostKey(existing.hostKey);

  let checked: string | null = null;
  if (connectionChanged) {
    const target: Target = {
      name,
      host,
      port,
      username,
      hostKey,
      ...(authType === "password" ? { password: secret } : { privateKey: secret, passphrase: passphrase ?? undefined }),
    };
    try {
      checked = (await checkServer(target)).output;
    } catch (err) {
      if (err instanceof SshProblem) throw problemError(err);
      throw err;
    }
  }

  return {
    values: {
      name,
      host,
      port,
      username,
      authType,
      secretCiphertext: encryptSecret(secret),
      passphraseCiphertext: passphrase ? encryptSecret(passphrase) : null,
      hostKey,
      access: input.access ?? existing?.access ?? "owners",
      status: input.status ?? existing?.status ?? "enabled",
      notes: input.notes === undefined ? (existing?.notes ?? null) : input.notes || null,
    },
    checked,
    connectionChanged,
  };
}

/** What the audit log keeps of a machine: where it is and how it is signed in to, never with what. */
export function auditFields(server: Pick<Server, "name" | "host" | "port" | "username" | "authType" | "hostKey" | "access" | "status">) {
  return {
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    signIn: server.authType,
    hostKey: fingerprint(server.hostKey),
    access: server.access,
    status: server.status,
  };
}
