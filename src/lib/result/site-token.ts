import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The address a project's files are shown at as a web site.
 *
 * A page an agent wrote is not trusted, so it is never shown as a page of the
 * app: it is served in a sandbox, where it has no origin and gets none of the
 * app's cookies. But then the page cannot ask for its own style sheet as the
 * signed-in person either. So the address itself carries the permission: a
 * token that names the project and an hour at which it ends, signed with a
 * key only this server has. Whoever has the address can look at that
 * project's files until then, and at nothing else.
 *
 * Pure: the key is passed in.
 */

/** How long an address is good for. */
export const SITE_TOKEN_HOURS = 24;

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function signature(key: Buffer, projectId: string, expires: string): string {
  return createHmac("sha256", key).update(`site:${projectId}:${expires}`).digest("base64url");
}

/** The key the tokens are signed with, from the server's own secret. */
export function siteKeyFrom(secret: Buffer): Buffer {
  return createHmac("sha256", secret).update("xiero-nexus: the address of a project's site, v1").digest();
}

export function signSiteToken(key: Buffer, projectId: string, expiresAt: number): string {
  if (!PROJECT_ID.test(projectId)) throw new Error("not a project id");
  const expires = Math.floor(expiresAt / 1000).toString(36);
  return `${projectId}.${expires}.${signature(key, projectId, expires)}`;
}

/** The project a token is for, when the token is this server's and has not ended. */
export function readSiteToken(key: Buffer, token: string, now: number): { projectId: string; expiresAt: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [projectId, expires, given] = parts as [string, string, string];
  if (!PROJECT_ID.test(projectId) || !/^[0-9a-z]{1,12}$/.test(expires) || !/^[A-Za-z0-9_-]{43}$/.test(given)) return null;
  const expected = Buffer.from(signature(key, projectId, expires));
  const got = Buffer.from(given);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const expiresAt = Number.parseInt(expires, 36) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { projectId, expiresAt };
}
