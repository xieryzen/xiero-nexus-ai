import "server-only";
import { env } from "../env";
import { SITE_TOKEN_HOURS, readSiteToken, signSiteToken, siteKeyFrom } from "./site-token";

/**
 * The address a project's files are shown at as a web site, with this
 * server's key (site-token.ts says why the address carries the permission).
 */

let key: Buffer | null = null;

function siteKey(): Buffer {
  key ??= siteKeyFrom(env.encryptionKey);
  return key;
}

/** Where a project's files are shown, and until when: "/site/<token>/". */
export function sitePreviewOf(projectId: string, now = Date.now()): { base: string; expiresAt: number } {
  // To the full hour, so that a page that asks again gets the same address
  // for a while: a preview that is open does not have to load anew.
  const expiresAt = (Math.floor(now / 3_600_000) + SITE_TOKEN_HOURS) * 3_600_000;
  return { base: `/site/${signSiteToken(siteKey(), projectId, expiresAt)}/`, expiresAt };
}

/** The project a token of such an address is for; null when it is not this server's or has ended. */
export function projectOfSiteToken(token: string): string | null {
  return readSiteToken(siteKey(), token, Date.now())?.projectId ?? null;
}
