import "server-only";
import { aesGcmDecrypt, aesGcmEncrypt } from "./crypto";
import { env } from "./env";

/** Encrypt a secret (e.g. provider API key or TOTP secret) for storage at rest. */
export function encryptSecret(plaintext: string): string {
  return aesGcmEncrypt(plaintext, env.encryptionKey);
}

/** Decrypt a secret previously stored with {@link encryptSecret}. */
export function decryptSecret(payload: string): string {
  return aesGcmDecrypt(payload, env.encryptionKey);
}

/** Last 4 characters of a secret, for masked display. Never returns more. */
export function last4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}
