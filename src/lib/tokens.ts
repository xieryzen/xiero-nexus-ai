import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "./audit";
import { AppError } from "./errors";
import { notify } from "./notifications";
import {
  TOKENS_USED_UP_CODE,
  formatTokens,
  isLimited,
  tokensLeft,
  usedUp,
  usedUpMessage,
  type TokenAccount,
} from "./token-rules";

/**
 * The tokens of an account, as the server keeps them (the rules are in
 * token-rules.ts). The count is on the account's row and grows with every
 * usage record of the account; work is refused when nothing is left.
 */

/** The account's tokens as they are now: read anew, since a run goes on long after it was started. */
export function tokenAccount(userId: string | null | undefined): TokenAccount | undefined {
  if (!userId) return undefined;
  return db
    .select({ role: users.role, tokenLimit: users.tokenLimit, tokensUsed: users.tokensUsed })
    .from(users)
    .where(eq(users.id, userId))
    .get();
}

/**
 * Whether work for this account can go on. Work that belongs to no account
 * (its owner was deleted, or it is the installation's own) is not limited.
 */
export function hasTokensLeft(userId: string | null | undefined): boolean {
  const account = tokenAccount(userId);
  return !account || !usedUp(account);
}

/** What the account can still use. Null: it is not limited, or there is no such account. */
export function tokensLeftFor(userId: string | null | undefined): number | null {
  const account = tokenAccount(userId);
  return account ? tokensLeft(account) : null;
}

/** The refusal itself, for where it is written down instead of thrown. */
export function usedUpError(account: TokenAccount, whose: "yours" | "project" = "yours"): AppError {
  // 402: the request is in order and its sender is allowed; what is missing is
  // tokens, and waiting brings none. A client must not try again by itself.
  return new AppError(402, TOKENS_USED_UP_CODE, usedUpMessage(account, whose));
}

/**
 * Refuses new work when the account has used its tokens up. Called before
 * anything is asked of a provider. `whose` is "project" when someone else
 * starts the work of this account.
 */
export function assertTokensLeft(userId: string | null | undefined, whose: "yours" | "project" = "yours"): void {
  const account = tokenAccount(userId);
  if (account && usedUp(account)) throw usedUpError(account, whose);
}

/**
 * Count tokens for an account. Called for every usage record that has an
 * account and tokens. The moment the balance is used up, the account is told
 * once, and it is in the audit log.
 */
export function chargeTokens(userId: string | null | undefined, tokens: number): void {
  if (!userId || !Number.isFinite(tokens) || tokens <= 0) return;
  const amount = Math.round(tokens);
  const after = db
    .update(users)
    .set({ tokensUsed: sql`${users.tokensUsed} + ${amount}` })
    .where(eq(users.id, userId))
    .returning({ role: users.role, tokenLimit: users.tokenLimit, tokensUsed: users.tokensUsed })
    .get();
  if (!after || !isLimited(after.role)) return;
  const crossed = after.tokensUsed >= after.tokenLimit && after.tokensUsed - amount < after.tokenLimit;
  if (!crossed) return;
  notify(userId, {
    kind: "system",
    level: "warning",
    title: "Your token balance is used up",
    body:
      `${formatTokens(after.tokensUsed)} of ${formatTokens(after.tokenLimit)} tokens used. New work is refused, and a run in progress stops, ` +
      "until an owner of this installation raises your limit.",
    link: "/dashboard/settings",
  });
  audit({
    actorUserId: null,
    action: "account.tokens.used_up",
    targetType: "user",
    targetId: userId,
    metadata: { tokenLimit: after.tokenLimit, tokensUsed: after.tokensUsed },
  });
}
