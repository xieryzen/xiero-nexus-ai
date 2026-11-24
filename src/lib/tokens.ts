import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "./audit";
import { AppError } from "./errors";
import { notify } from "./notifications";
import { getPlanSettings } from "./plans";
import {
  TOKENS_USED_UP_CODE,
  allowanceOf,
  countedTokens,
  formatTokens,
  periodOf,
  renewalDay,
  renewsAt,
  tokenSummary,
  tokensLeft,
  usedUp,
  usedUpMessage,
  type TokenAccount,
  type TokenSummary,
} from "./token-rules";

/**
 * The tokens of an account, as the server keeps them (the rules are in
 * token-rules.ts). The count of the month is on the account's row and grows
 * with every usage record of the account; work is refused when nothing is
 * left of the month's allowance.
 */

const TOKEN_COLUMNS = {
  role: users.role,
  plan: users.plan,
  tokenAllowance: users.tokenAllowance,
  tokensPeriod: users.tokensPeriod,
  periodTokens: users.periodTokens,
  tokensUsed: users.tokensUsed,
};

/** The account's tokens as they are now: read anew, since a run goes on long after it was started. */
export function tokenAccount(userId: string | null | undefined): TokenAccount | undefined {
  if (!userId) return undefined;
  return db.select(TOKEN_COLUMNS).from(users).where(eq(users.id, userId)).get();
}

/** What an account has, has used and has left this month, with the plans as they are set now. */
export function tokensOf(account: TokenAccount): TokenSummary {
  return tokenSummary(account, getPlanSettings());
}

/**
 * Whether work for this account can go on. Work that belongs to no account
 * (its owner was deleted, or it is the installation's own) is not limited.
 */
export function hasTokensLeft(userId: string | null | undefined): boolean {
  const account = tokenAccount(userId);
  return !account || !usedUp(account, getPlanSettings());
}

/** What the account can still use this month. Null: it is not limited, or there is no such account. */
export function tokensLeftFor(userId: string | null | undefined): number | null {
  const account = tokenAccount(userId);
  return account ? tokensLeft(account, getPlanSettings()) : null;
}

/** What is said when the work of an account stops because its tokens are used up. */
export function usedUpText(userId: string | null | undefined, whose: "yours" | "project" = "yours"): string {
  const account = tokenAccount(userId);
  if (!account) return "The tokens for this month of the project's account are used up.";
  return usedUpMessage(tokensOf(account), whose);
}

/** The refusal itself, for where it is written down instead of thrown. */
export function usedUpError(account: TokenAccount, whose: "yours" | "project" = "yours"): AppError {
  // 402: the request is in order and its sender is allowed; what is missing is
  // tokens, and trying again at once brings none. A client must not try again by itself.
  return new AppError(402, TOKENS_USED_UP_CODE, usedUpMessage(tokensOf(account), whose));
}

/**
 * Refuses new work when the account has used its tokens up. Called before
 * anything is asked of a provider. `whose` is "project" when someone else
 * starts the work of this account.
 */
export function assertTokensLeft(userId: string | null | undefined, whose: "yours" | "project" = "yours"): void {
  const account = tokenAccount(userId);
  if (account && usedUp(account, getPlanSettings())) throw usedUpError(account, whose);
}

/**
 * Count the tokens of a request for an account. Called for every usage
 * record that has an account and tokens. The output counts in full and the
 * input by the input weight; every token is added to the account's count of
 * all time as well. The moment the month's allowance is used up, the account
 * is told once, and it is in the audit log.
 */
export function chargeTokens(userId: string | null | undefined, promptTokens: number, completionTokens: number): void {
  if (!userId) return;
  const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? Math.round(promptTokens) : 0;
  const completion = Number.isFinite(completionTokens) && completionTokens > 0 ? Math.round(completionTokens) : 0;
  if (prompt + completion === 0) return;
  const settings = getPlanSettings();
  const counted = countedTokens(prompt, completion, settings.inputWeight);
  const period = periodOf();
  const after = db
    .update(users)
    .set({
      tokensUsed: sql`${users.tokensUsed} + ${prompt + completion}`,
      // A new month starts the count again.
      periodTokens: sql`CASE WHEN ${users.tokensPeriod} = ${period} THEN ${users.periodTokens} + ${counted} ELSE ${counted} END`,
      tokensPeriod: period,
    })
    .where(eq(users.id, userId))
    .returning(TOKEN_COLUMNS)
    .get();
  if (!after) return;
  const allowance = allowanceOf(after, settings);
  if (allowance === null) return;
  const crossed = after.periodTokens >= allowance && after.periodTokens - counted < allowance;
  if (!crossed) return;
  notify(userId, {
    kind: "system",
    level: "warning",
    title: "Your tokens for this month are used up",
    body:
      `${formatTokens(after.periodTokens)} of ${formatTokens(allowance)} tokens used. New work is refused, and a run in progress stops. ` +
      `They are there again on ${renewalDay(renewsAt())}; an owner of this installation can give you more.`,
    link: "/dashboard/settings",
  });
  audit({
    actorUserId: null,
    action: "account.tokens.used_up",
    targetType: "user",
    targetId: userId,
    metadata: { allowance, used: after.periodTokens, period },
  });
}
