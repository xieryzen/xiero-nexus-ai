import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { AppError, wasNotReached } from "./errors";
import { safeFetch } from "./http-client";
import { VERDICT_FOR_MS, WITNESS_TIMEOUT_MS, asksWitnesses, cutOff, witnessesFor, type Witness } from "./reach-rules";
import { runtime } from "./runtime";

/**
 * Is this server cut off? Asked when a request to a provider failed without
 * an answer, before that failure is held against the provider's models. The
 * rules, and why, are in reach-rules.ts.
 */

interface ReachState {
  /** When the witnesses were last asked. */
  at: number;
  cutOff: boolean;
  /** They are being asked: whoever asks meanwhile gets the same answer. */
  asking: Promise<boolean> | null;
}

/** One per server process: the worker and the request handlers see the same. */
function reachState(): ReachState {
  const cache = runtime().cache;
  let entry = cache.get("reach");
  if (!entry) {
    entry = { value: { at: 0, cutOff: false, asking: null } satisfies ReachState, at: Date.now() };
    cache.set("reach", entry);
  }
  return entry.value as ReachState;
}

function allowedPrivateHosts(): string[] {
  return (process.env.ALLOW_PRIVATE_PROVIDER_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The providers that are switched on, each with when one of its models last answered. */
function known(): Witness[] {
  return db
    .select({
      baseUrl: providers.baseUrl,
      answeredAt: sql<number | null>`max(case when ${models.lastTestStatus} = 'ok' then ${models.lastTestedAt} end)`,
    })
    .from(providers)
    .leftJoin(models, eq(models.providerId, providers.id))
    .where(eq(providers.status, "enabled"))
    .groupBy(providers.id)
    .all()
    // The time is kept in seconds; all that matters here is which is later.
    .map((row) => ({ baseUrl: row.baseUrl, answeredAt: row.answeredAt === null ? null : Number(row.answeredAt) }));
}

/** One witness: does anything answer at its address? No key is sent, and nothing is asked for. */
async function answers(baseUrl: string): Promise<boolean> {
  try {
    await safeFetch(baseUrl, { method: "HEAD" }, { timeoutMs: WITNESS_TIMEOUT_MS, allowHosts: allowedPrivateHosts(), redirect: "manual" });
    return true;
  } catch (err) {
    // No connection, no address for its name, nothing in time: not reached.
    // Whatever else went wrong, something was there to go wrong with.
    return !(wasNotReached(err) || (err instanceof AppError && err.code === "timeout"));
  }
}

/**
 * Whether this server is cut off, as far as the providers other than the one
 * at `failedBaseUrl` can tell. False when there is none to ask.
 */
export async function isCutOff(failedBaseUrl: string): Promise<boolean> {
  const state = reachState();
  if (state.asking) return state.asking;
  if (Date.now() - state.at < VERDICT_FOR_MS) return state.cutOff;
  const asking = (async () => {
    let verdict = false;
    try {
      const witnesses = witnessesFor(failedBaseUrl, known());
      verdict = cutOff(await Promise.all(witnesses.map(answers)));
    } catch {
      // Not knowing is not being cut off.
      verdict = false;
    }
    state.at = Date.now();
    state.cutOff = verdict;
    return verdict;
  })();
  state.asking = asking;
  try {
    return await asking;
  } finally {
    state.asking = null;
  }
}

/**
 * A provider answered: the way out works, whatever was found a moment ago.
 * Without this a server would count as cut off for a while after its
 * connection is back, and the first provider that really is out of reach
 * then would get away with it.
 */
export function sawAnswer(): void {
  const state = reachState();
  if (state.cutOff) {
    state.cutOff = false;
    state.at = 0;
  }
}

/**
 * Whether a request to a provider failed because this server is cut off:
 * it failed without an answer, and no other provider can be reached either.
 * Such a failure says nothing about the provider or its model.
 */
export async function failedForNoConnection(provider: { baseUrl: string }, err: unknown): Promise<boolean> {
  if (!(err instanceof AppError) || !asksWitnesses(err.code)) return false;
  return isCutOff(provider.baseUrl);
}

/**
 * What a failed request says about the way out, before anyone is asked: an
 * answer of the provider, of whatever kind, is proof that it works.
 */
export function sawFailure(err: unknown): void {
  if (err instanceof AppError && /^Provider responded \d{3}\b/.test(err.message)) sawAnswer();
}
