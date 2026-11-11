import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Pure cryptographic primitives. No environment or server-only imports here,
 * so these can be unit-tested directly. The app binds the encryption key via
 * `secrets.ts`.
 */

// ─── AES-256-GCM (for secrets at rest) ────────────────────────────────────────

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function aesGcmEncrypt(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function aesGcmDecrypt(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

// ─── Password hashing (scrypt) ─────────────────────────────────────────────────
// scrypt is a memory-hard, one-way KDF built into Node/OpenSSL. Chosen over a
// native Argon2 addon for dependency-free, reliable deployment (e.g. Pterodactyl).
// Format: scrypt$N$r$p$keylen$saltB64$hashB64

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_KEYLEN,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keylen = Number(parts[4]);
  const salt = Buffer.from(parts[5]!, "base64");
  const expected = Buffer.from(parts[6]!, "base64");
  if (!N || !r || !p || !keylen || expected.length !== keylen) return false;
  const actual = scryptSync(password.normalize("NFKC"), salt, keylen, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ─── Hashing & tokens ──────────────────────────────────────────────────────────

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Recovery codes ────────────────────────────────────────────────────────────
// Unambiguous alphabet (no 0/O/1/I). Codes are shown once; only hashes stored.

const RC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRecoveryCodes(
  count = 10,
): { code: string; hash: string }[] {
  const out: { code: string; hash: string }[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(10);
    let s = "";
    for (let j = 0; j < 8; j++) {
      s += RC_ALPHABET[raw[j]! % RC_ALPHABET.length];
    }
    const code = `${s.slice(0, 4)}-${s.slice(4, 8)}`;
    out.push({ code, hash: sha256(code) });
  }
  return out;
}
