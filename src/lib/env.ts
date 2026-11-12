import "server-only";
import { dirname, join } from "node:path";

/**
 * Lazily-read, validated environment access. Values are read on first use
 * (never at module load) so that `next build` does not require runtime secrets.
 */

function readKey(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SECRET_ENCRYPTION_KEY is required in production. Generate one with: " +
          `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    // Development fallback: deterministic, clearly-not-secret key so the app
    // boots without configuration. Encrypted data will NOT survive a key change.
    // eslint-disable-next-line no-console
    console.warn(
      "[xiero-nexus] SECRET_ENCRYPTION_KEY not set — using an insecure dev key. " +
        "Set a real key before storing any real credentials.",
    );
    return Buffer.alloc(32, 7);
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (base64).",
    );
  }
  return key;
}

let cachedKey: Buffer | null = null;
let warnedInsecureCookies = false;

export const env = {
  get encryptionKey(): Buffer {
    cachedKey ??= readKey();
    return cachedKey;
  },
  get databasePath(): string {
    return process.env.DATABASE_PATH ?? "./data/nexus.db";
  },
  /**
   * Folder for generated images and videos. By default a `media` folder next
   * to the database file, so both are backed up and kept together.
   */
  get mediaPath(): string {
    const raw = process.env.MEDIA_PATH?.trim();
    return raw ? raw : join(dirname(this.databasePath), "media");
  },
  get appUrl(): string {
    return process.env.APP_URL ?? "http://localhost:3000";
  },
  get isProd(): boolean {
    return process.env.NODE_ENV === "production";
  },
  /**
   * Whether session cookies carry the Secure flag (sent over HTTPS only).
   * On by default in production; COOKIE_SECURE=false allows plain-HTTP
   * deployments, where the browser would otherwise drop the cookie.
   */
  get cookieSecure(): boolean {
    const raw = process.env.COOKIE_SECURE?.trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") {
      if (process.env.NODE_ENV === "production" && !warnedInsecureCookies) {
        warnedInsecureCookies = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[xiero-nexus] COOKIE_SECURE=false — session cookies are also sent over plain HTTP. " +
            "Passwords and sessions can be intercepted on the network; put the app behind HTTPS when you can.",
        );
      }
      return false;
    }
    return process.env.NODE_ENV === "production";
  },
  bootstrapAdmin() {
    const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!username || !email || !password) return null;
    return { username, email, password };
  },
};
