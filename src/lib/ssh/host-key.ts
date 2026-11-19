import { createHash } from "node:crypto";

/**
 * The host key of a machine: what it shows to prove that it is the machine
 * that was registered. Pure (Node's crypto only): used by the server and by
 * the tests, not by a page.
 *
 * It is kept as one line, the way OpenSSH writes it in known_hosts and in
 * /etc/ssh/ssh_host_*_key.pub: "ssh-ed25519 AAAAC3Nza…". Its fingerprint is
 * what `ssh-keygen -lf` prints: "SHA256:…".
 */

/** The key types a machine may show. */
const KEY_TYPE = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|rsa-sha2-(?:256|512)|sk-[a-z0-9@.-]+)$/;

export interface HostKey {
  type: string;
  blob: Buffer;
}

/** The type a key blob names in its first field. Null when it is not a key. */
function typeOf(blob: Buffer): string | null {
  if (blob.length < 8) return null;
  const length = blob.readUInt32BE(0);
  if (length < 4 || length > 64 || 4 + length > blob.length) return null;
  const type = blob.subarray(4, 4 + length).toString("ascii");
  return KEY_TYPE.test(type) ? type : null;
}

/** The line for the key a machine showed in a connection. Null when it is not a key. */
export function hostKeyLine(blob: Uint8Array): string | null {
  const bytes = Buffer.from(blob);
  const type = typeOf(bytes);
  return type ? `${type} ${bytes.toString("base64")}` : null;
}

/**
 * A host key from a line: "type base64", with or without a host in front (a
 * known_hosts line) and a comment after it. Null when it is not one.
 */
export function parseHostKey(line: string): HostKey | null {
  const fields = line.trim().split(/\s+/);
  for (let i = 0; i + 1 < fields.length && i < 2; i++) {
    const type = fields[i]!;
    if (!KEY_TYPE.test(type)) continue;
    const text = fields[i + 1]!;
    if (!/^[A-Za-z0-9+/]+=*$/.test(text)) return null;
    const blob = Buffer.from(text, "base64");
    // The blob says its own type: a line whose two halves disagree is not a key.
    return typeOf(blob) === type ? { type, blob } : null;
  }
  return null;
}

/** The line in the one form it is kept in. Null when it is not a host key. */
export function normalizeHostKey(line: string): string | null {
  const key = parseHostKey(line);
  return key ? `${key.type} ${key.blob.toString("base64")}` : null;
}

/** What `ssh-keygen -lf` prints for the key: "SHA256:…". Null when the line is not a key. */
export function fingerprint(line: string): string | null {
  const key = parseHostKey(line);
  if (!key) return null;
  return `SHA256:${createHash("sha256").update(key.blob).digest("base64").replace(/=+$/, "")}`;
}

/** Whether two lines are the same key. */
export function sameHostKey(a: string, b: string): boolean {
  const x = parseHostKey(a);
  const y = parseHostKey(b);
  return Boolean(x && y && x.type === y.type && x.blob.equals(y.blob));
}

/** The file on the machine that holds this key, for the hint on how to compare. */
export function hostKeyFile(type: string): string {
  const short = type.startsWith("ecdsa-") ? "ecdsa" : type === "ssh-ed25519" ? "ed25519" : type === "ssh-dss" ? "dsa" : "rsa";
  return `/etc/ssh/ssh_host_${short}_key.pub`;
}
