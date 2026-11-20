/**
 * The tokens of an account: how many it may use, how many it has used, and
 * what is left. Pure: used by the server and by the pages, and tested alone.
 *
 * - An account has a limit and a count of what it used. The count only
 *   grows: nothing is given back by the calendar. More is had when an owner
 *   raises the limit.
 * - An owner is not held to a limit: whoever hands the tokens out, and whose
 *   provider keys they are spent on, is not stopped by them. What an owner
 *   uses is counted all the same.
 * - What is counted is what the work of the account used: chat, the runs of
 *   its projects, embeddings, media, the public API with its keys. A check
 *   of a model is the installation's, and is counted for nobody.
 * - Nothing else holds the tokens of a run: a project has no budget of its
 *   own. A run goes on while its account has tokens left, and stops when
 *   they are used up.
 */

import { isOwnerRole } from "./roles";

/** What a new account may use, unless DEFAULT_TOKEN_LIMIT says otherwise. */
export const DEFAULT_TOKEN_LIMIT = 10_000_000;

/** The highest limit that can be set: far below what a number holds exactly. */
export const MAX_TOKEN_LIMIT = 1_000_000_000_000;

export interface TokenAccount {
  role: string;
  tokenLimit: number;
  tokensUsed: number;
}

/** What a new account may use: DEFAULT_TOKEN_LIMIT of the environment, or ten million. */
export function defaultTokenLimit(raw: string | undefined = process.env.DEFAULT_TOKEN_LIMIT): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_TOKEN_LIMIT;
  const value = Number(text.replace(/[_,]/g, ""));
  if (!Number.isInteger(value) || value < 0 || value > MAX_TOKEN_LIMIT) return DEFAULT_TOKEN_LIMIT;
  return value;
}

/** Whether a limit holds for an account of this role. */
export function isLimited(role: string | null | undefined): boolean {
  return !isOwnerRole(role);
}

/** The tokens the account can still use. Null: it is not limited. Never below zero. */
export function tokensLeft(account: TokenAccount): number | null {
  if (!isLimited(account.role)) return null;
  return Math.max(0, account.tokenLimit - account.tokensUsed);
}

/** Whether the account has nothing left to start work with. */
export function usedUp(account: TokenAccount): boolean {
  return tokensLeft(account) === 0;
}

export interface TokenSummary {
  /** Null: the account is not limited. */
  limit: number | null;
  used: number;
  /** Null: the account is not limited. */
  left: number | null;
  usedUp: boolean;
}

export function tokenSummary(account: TokenAccount): TokenSummary {
  const left = tokensLeft(account);
  return {
    limit: left === null ? null : account.tokenLimit,
    used: account.tokensUsed,
    left,
    usedUp: left === 0,
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
 * "10.000.000" and "10 000 000" are all ten million. Null: it is not a whole
 * number of tokens, or more than can be set.
 */
export function parseTokens(text: string): number | null {
  const digits = text.trim().replace(/[\s.,_]/g, "");
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

/**
 * What is said when work is refused or stopped because the tokens are used
 * up. `whose`: "yours" to the account itself, "project" to someone else who
 * runs a project of that account.
 */
export function usedUpMessage(account: TokenAccount, whose: "yours" | "project" = "yours"): string {
  const numbers = `${formatTokens(account.tokensUsed)} of ${formatTokens(account.tokenLimit)} tokens used`;
  return whose === "yours"
    ? `Your token balance is used up: ${numbers}. An owner of this installation can raise your limit.`
    : `The token balance of the account this project belongs to is used up: ${numbers}. An owner of this installation can raise its limit.`;
}

/** The error code of work refused because the tokens are used up. */
export const TOKENS_USED_UP_CODE = "token_limit_reached";
