/**
 * Is this server cut off? The rules, pure (reach.ts asks).
 *
 * A request to a provider that never got there says one of two things: that
 * provider is out of reach, or this server is. From the one request the two
 * look the same, and they are not the same for what follows. A provider that
 * is out of reach has its models put away until a check passes
 * (model-health-rules.ts). A server that lost its connection for an hour has
 * lost that hour and nothing else: its models are as good as they were, and
 * putting them all away leaves it with empty lists for hours after the
 * connection is back.
 *
 * So the other providers are the witnesses. When a request to one did not get
 * there, up to three of the others are asked for nothing but an answer, the
 * ones first that worked last. One answer, whatever it says, and the way out
 * works: the failure is that one provider's. No answer from any of them, and
 * this server is cut off. Where there is no other provider that ever
 * answered there is no witness, and nothing is concluded: everything is as
 * it was before this was asked.
 *
 * A provider that never answered can speak for the way out and not against
 * it: when it is reached, the way out works; when it is not, that says
 * nothing, since nobody knows that it ever could be. So a few of those are
 * asked as well, and this server counts as cut off only when one that has
 * answered before is among those asked and none of them all was reached.
 * Without them, two providers that are gone for good would look like a lost
 * connection for ever, and a provider added after them would never be asked
 * by the check of the models, which ends its round where the server is cut
 * off.
 *
 * A witness has to be as far away as the provider that failed. A model that
 * runs next to the app (on the same machine, in its network) answers whether
 * or not the app has a way out: it is no witness for a provider out there,
 * and a provider out there is none for it.
 */

import { isIP } from "node:net";
import { isPrivateIp } from "./ssrf";

/** How many other providers that have answered before are asked. */
export const WITNESSES = 3;
/** And how many that never answered: they can only say that the way out works. */
export const UNPROVEN_WITNESSES = 2;
/** How long one of them is waited for. */
export const WITNESS_TIMEOUT_MS = 4_000;
/** How long what they said is taken to hold: the requests of one moment fail together, and are not each a reason to ask. */
export const VERDICT_FOR_MS = 20_000;

/**
 * The address a provider is asked at, as far as it tells two providers
 * apart: scheme, host and port. Null when it is no web address.
 */
export function originOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Names that are given to machines of one's own network. */
const NEAR_ENDINGS = [".localhost", ".local", ".lan", ".internal", ".intranet", ".home", ".home.arpa", ".localdomain"];

/**
 * Whether a provider is next to the app, as far as its address tells: an
 * address of a private range, "localhost", a name without a dot (the name of
 * a container or of a machine in the same network) or with an ending that is
 * used for one's own network. A name that leads to a private address without
 * showing it counts as out there: it is then a witness that is always
 * reached, and the conclusion is the careful one, that the way out works.
 */
export function isNear(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (isIP(host) !== 0) return isPrivateIp(host);
  return host === "localhost" || !host.includes(".") || NEAR_ENDINGS.some((ending) => host.endsWith(ending));
}

/** A provider that can be a witness. */
export interface Witness {
  baseUrl: string;
  /** When one of its models last answered, in milliseconds. Null: none ever did. */
  answeredAt: number | null;
}

/** The providers that are asked, by their addresses. */
export interface Witnesses {
  /** The ones that have answered before, those that answered last first. */
  proven: string[];
  /** The ones that never answered. */
  unproven: string[];
}

/**
 * The witnesses for a request to `failedBaseUrl` that did not get there:
 * providers at other addresses, as near or as far as the one that failed,
 * each address once. WITNESSES at most of those that have answered before,
 * the ones that answered last first, and UNPROVEN_WITNESSES at most of those
 * that never did.
 */
export function witnessesFor(failedBaseUrl: string, others: readonly Witness[]): Witnesses {
  const failed = originOf(failedBaseUrl);
  const near = isNear(failedBaseUrl);
  const byOrigin = new Map<string, Witness>();
  for (const one of others) {
    const origin = originOf(one.baseUrl);
    if (!origin || origin === failed || isNear(one.baseUrl) !== near) continue;
    const kept = byOrigin.get(origin);
    // Of two providers at one address, the one that answered, and of two that did the one that answered last.
    if (!kept || (one.answeredAt ?? -1) > (kept.answeredAt ?? -1)) byOrigin.set(origin, one);
  }
  const all = [...byOrigin.values()];
  return {
    proven: all
      .filter((one) => one.answeredAt !== null)
      .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))
      .slice(0, WITNESSES)
      .map((one) => one.baseUrl),
    unproven: all
      .filter((one) => one.answeredAt === null)
      .slice(0, UNPROVEN_WITNESSES)
      .map((one) => one.baseUrl),
  };
}

/**
 * What the witnesses say, each by whether it was reached. Cut off: one that
 * has answered before was asked, and none of them all was reached.
 */
export function cutOff(proven: readonly boolean[], unproven: readonly boolean[] = []): boolean {
  return proven.length > 0 && !proven.some(Boolean) && !unproven.some(Boolean);
}

/**
 * The codes of a failed request after which the witnesses are asked: no
 * connection, no address for the name, no answer in time. Any other failure
 * is an answer of the provider, and proof that the way out works.
 */
export function asksWitnesses(code: string | null | undefined): boolean {
  return code === "network_error" || code === "dns_error" || code === "timeout";
}

/** What is added to a failed request's words when this server is cut off. Written for those who are shown the setup. */
export const CUT_OFF_NOTE =
  "This server could not connect to any other provider either: its own connection to the internet, or its name lookup (DNS), seems to be down.";
