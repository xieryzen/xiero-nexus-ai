/**
 * The tokens of an account: how many it may use in a month, how many it has
 * used, and what is left. Pure: used by the server and by the pages, and
 * tested alone.
 *
 * - An account has an allowance for a calendar month (UTC): the one of its
 *   role (plan-rules.ts), or its own where an owner set one. On the first of
 *   the month the count starts again: nothing has to be raised by hand.
 * - What is counted against it is weighted: a token of output counts as one,
 *   a token of input as a quarter (the input weight of the plan settings).
 *   Work with tools sends the same conversation again with every step, and a
 *   provider bills input at a fraction of output: counted in full, an
 *   allowance was gone half way through one long document.
 * - An owner is not held to an allowance: whoever hands the tokens out, and
 *   whose provider keys they are spent on, is not stopped by them. What an
 *   owner uses is counted all the same.
 * - What is counted is what the work of the account used: chat, the runs of
 *   its projects, embeddings, media, the public API with its keys. A check
 *   of a model is the installation's, and is counted for nobody.
 * - Every token an account ever used is kept as well, unweighted: for
 *   information. It limits nothing.
 */

import { planOf, type PlanSettings } from "./plan-rules";
import { isOwnerRole, tierOf } from "./roles";

/** The highest allowance that can be set: far below what a number holds exactly. */
export const MAX_TOKEN_LIMIT = 1_000_000_000_000;

export interface TokenAccount {
  role: string;
  plan?: string | null;
  /** Its own allowance for a month, where an owner set one. Null: the one of its role. */
  tokenAllowance: number | null;
  /** The month the count below is of: "2026-11". Another month: nothing is used yet. */
  tokensPeriod: string;
  /** What it used in that month, as it is counted. */
  periodTokens: number;
  /** Every token it ever used, unweighted. */
  tokensUsed: number;
}

/** The month a moment is in, in UTC: "2026-11". */
export function periodOf(now: number | Date = Date.now()): string {
  const at = new Date(now);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** When the count starts again: the first moment of the next month, in UTC. */
export function renewsAt(now: number | Date = Date.now()): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/**
 * What a request counts against the allowance: its output in full, its input
 * by the input weight. A whole number, and never less than one for a request
 * that used anything.
 */
export function countedTokens(promptTokens: number, completionTokens: number, inputWeight: number): number {
  const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const completion = Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
  if (prompt + completion === 0) return 0;
  return Math.max(1, Math.round(prompt * inputWeight + completion));
}

/** Whether an allowance holds for an account of this role. */
export function isLimited(role: string | null | undefined): boolean {
  return !isOwnerRole(role);
}

/** What the account may use in a month. Null: it is not limited. */
export function allowanceOf(account: TokenAccount, settings: PlanSettings): number | null {
  if (!isLimited(account.role)) return null;
  if (account.tokenAllowance !== null && account.tokenAllowance !== undefined) return account.tokenAllowance;
  return planOf(settings, tierOf(account)).monthlyTokens ?? 0;
}

/** What the account used in the month of `now`, as it is counted. */
export function usedInPeriod(account: TokenAccount, now: number | Date = Date.now()): number {
  return account.tokensPeriod === periodOf(now) ? Math.max(0, account.periodTokens) : 0;
}

/** The tokens the account can still use this month. Null: it is not limited. Never below zero. */
export function tokensLeft(account: TokenAccount, settings: PlanSettings, now: number | Date = Date.now()): number | null {
  const allowance = allowanceOf(account, settings);
  if (allowance === null) return null;
  return Math.max(0, allowance - usedInPeriod(account, now));
}

/** Whether the account has nothing left to start work with. */
export function usedUp(account: TokenAccount, settings: PlanSettings, now: number | Date = Date.now()): boolean {
  return tokensLeft(account, settings, now) === 0;
}

export interface TokenSummary {
  /** What it may use in a month. Null: the account is not limited. */
  limit: number | null;
  /** What it used this month, as it is counted. */
  used: number;
  /** Null: the account is not limited. */
  left: number | null;
  usedUp: boolean;
  /** The allowance is the account's own, not the one of its role. */
  custom: boolean;
  /** Every token it ever used, unweighted. */
  total: number;
  /** When the count starts again, in milliseconds. */
  renewsAt: number;
}

export function tokenSummary(account: TokenAccount, settings: PlanSettings, now: number | Date = Date.now()): TokenSummary {
  const limit = allowanceOf(account, settings);
  const used = usedInPeriod(account, now);
  const left = limit === null ? null : Math.max(0, limit - used);
  return {
    limit,
    used,
    left,
    usedUp: left === 0,
    custom: limit !== null && account.tokenAllowance !== null && account.tokenAllowance !== undefined,
    total: account.tokensUsed,
    renewsAt: renewsAt(now),
  };
}

/** 1234567 → "1,234,567". The same on the server and in the browser. */
export function formatTokens(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A number of tokens as a person typed it: "10000000", "10,000,000",
 * "10.000.000" and "10 000 000" are all ten million, and so are "10M" and
 * "10 jt"; "250k" is 250,000. Null: it is not a whole number of tokens, or
 * more than can be set.
 */
export function parseTokens(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  // "2.5M", "2,5 jt": at most two decimals, so that "1,000k" is not taken for one thousand.
  const short = /^(\d{1,6})(?:[.,](\d{1,2}))?\s*(k|rb|ribu|m|jt|juta|b|mlr|miliar)$/.exec(trimmed);
  if (short) {
    const unit = short[3]!;
    const scale = unit === "k" || unit === "rb" || unit === "ribu" ? 1_000 : unit === "m" || unit === "jt" || unit === "juta" ? 1_000_000 : 1_000_000_000;
    const value = Math.round(Number(`${short[1]}.${short[2] ?? "0"}`) * scale);
    return value <= MAX_TOKEN_LIMIT ? value : null;
  }
  const digits = trimmed.replace(/[\s.,_]/g, "");
  if (!/^\d{1,13}$/.test(digits)) return null;
  const value = Number(digits);
  return value <= MAX_TOKEN_LIMIT ? value : null;
}

/** 9,870,000 → "9.87M", 12,300 → "12.3K": for a place with little room. */
export function shortTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  const short = (scaled: number, unit: string) => {
    // Cut, not rounded: what is left is never shown as more than it is.
    const text = (Math.floor(scaled * 100) / 100).toString();
    return `${text}${unit}`;
  };
  if (n >= 1_000_000_000) return short(n / 1_000_000_000, "B");
  if (n >= 1_000_000) return short(n / 1_000_000, "M");
  if (n >= 10_000) return short(n / 1_000, "K");
  return formatTokens(n);
}

/** "1 December": the day the count starts again, in UTC, the same on the server and in the browser. */
export function renewalDay(at: number): string {
  const date = new Date(at);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

/**
 * What is said when work is refused or stopped because the tokens are used
 * up. `whose`: "yours" to the account itself, "project" to someone else who
 * runs a project of that account.
 */
export function usedUpMessage(summary: Pick<TokenSummary, "limit" | "used" | "renewsAt">, whose: "yours" | "project" = "yours"): string {
  const numbers = `${formatTokens(summary.used)} of ${formatTokens(summary.limit ?? 0)} tokens used`;
  const again = `They are there again on ${renewalDay(summary.renewsAt)}`;
  return whose === "yours"
    ? `Your tokens for this month are used up: ${numbers}. ${again}; an owner of this installation can give you more.`
    : `The tokens for this month of the account this project belongs to are used up: ${numbers}. ${again}; an owner of this installation can give it more.`;
}

/** The error code of work refused because the tokens are used up. */
export const TOKENS_USED_UP_CODE = "token_limit_reached";
