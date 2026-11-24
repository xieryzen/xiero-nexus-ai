import { test } from "node:test";
import assert from "node:assert/strict";
import { shippedSettings } from "../src/lib/plan-rules";
import {
  MAX_TOKEN_LIMIT,
  allowanceOf,
  countedTokens,
  formatTokens,
  isLimited,
  parseTokens,
  periodOf,
  renewalDay,
  renewsAt,
  shortTokens,
  tokenSummary,
  tokensLeft,
  usedInPeriod,
  usedUp,
  usedUpMessage,
  type TokenAccount,
} from "../src/lib/token-rules";

const SETTINGS = shippedSettings({});
const NOVEMBER = Date.UTC(2026, 10, 24, 6, 56);
const DECEMBER = Date.UTC(2026, 11, 1, 0, 0, 1);

const account = (over: Partial<TokenAccount> & { role: string }): TokenAccount => ({
  plan: null,
  tokenAllowance: null,
  tokensPeriod: "2026-11",
  periodTokens: 0,
  tokensUsed: 0,
  ...over,
});

test("the month of a moment is the calendar month in UTC, and the count starts again on its first day", () => {
  assert.equal(periodOf(NOVEMBER), "2026-11");
  assert.equal(periodOf(Date.UTC(2026, 10, 30, 23, 59, 59)), "2026-11");
  assert.equal(periodOf(DECEMBER), "2026-12");
  assert.equal(periodOf(Date.UTC(2027, 0, 1)), "2027-01");
  assert.equal(renewsAt(NOVEMBER), Date.UTC(2026, 11, 1));
  // December ends in the next year.
  assert.equal(renewsAt(Date.UTC(2026, 11, 31, 12)), Date.UTC(2027, 0, 1));
  assert.equal(renewalDay(renewsAt(NOVEMBER)), "1 December");
});

test("what a request counts: its output in full, its input by a quarter", () => {
  // A step of work with tools: a long conversation sent again, a short call back.
  assert.equal(countedTokens(40_000, 500, 0.25), 10_500);
  // Counted in full, as before 2.0.
  assert.equal(countedTokens(40_000, 500, 1), 40_500);
  // Only what the model writes.
  assert.equal(countedTokens(40_000, 500, 0), 500);
  // A request that used anything counts at least one; one that used nothing counts nothing.
  assert.equal(countedTokens(1, 0, 0.25), 1);
  assert.equal(countedTokens(3, 0, 0), 1);
  assert.equal(countedTokens(0, 0, 0.25), 0);
  // What is no number of tokens is nothing.
  assert.equal(countedTokens(Number.NaN, -5, 0.25), 0);
  assert.equal(countedTokens(-10, 20, 0.25), 20);
});

test("a long piece of work lasts about three times as long as when every token counted in full", () => {
  // Forty steps, each sending the conversation so far (it grows by what was written) and writing 800 tokens.
  let full = 0;
  let weighted = 0;
  let conversation = 6_000;
  for (let step = 0; step < 40; step++) {
    full += countedTokens(conversation, 800, 1);
    weighted += countedTokens(conversation, 800, 0.25);
    conversation += 1_500;
  }
  assert.equal(full > 1_400_000, true, String(full));
  assert.equal(full / weighted > 3, true, String(full / weighted));
});

test("an owner is not held to an allowance; an admin and a user are", () => {
  assert.equal(isLimited("owner"), false);
  assert.equal(isLimited("admin"), true);
  assert.equal(isLimited("user"), true);
  assert.equal(isLimited(undefined), true);
});

test("the allowance of an account is the one of its role, unless an owner gave it its own", () => {
  assert.equal(allowanceOf(account({ role: "user" }), SETTINGS), 10_000_000);
  assert.equal(allowanceOf(account({ role: "user", plan: "free" }), SETTINGS), 10_000_000);
  assert.equal(allowanceOf(account({ role: "user", plan: "pro" }), SETTINGS), 25_000_000);
  assert.equal(allowanceOf(account({ role: "user", plan: "plus" }), SETTINGS), 50_000_000);
  assert.equal(allowanceOf(account({ role: "user", plan: "ultra" }), SETTINGS), 100_000_000);
  assert.equal(allowanceOf(account({ role: "admin" }), SETTINGS), 250_000_000);
  assert.equal(allowanceOf(account({ role: "owner" }), SETTINGS), null);
  // Its own: more, less, or nothing at all.
  assert.equal(allowanceOf(account({ role: "user", plan: "pro", tokenAllowance: 3_000_000 }), SETTINGS), 3_000_000);
  assert.equal(allowanceOf(account({ role: "user", tokenAllowance: 0 }), SETTINGS), 0);
  // An owner has none, whatever was once set for the account.
  assert.equal(allowanceOf(account({ role: "owner", tokenAllowance: 5 }), SETTINGS), null);
  // A plan that is not one is FREE.
  assert.equal(allowanceOf(account({ role: "user", plan: "gold" }), SETTINGS), 10_000_000);
});

test("what was used counts for its month only: in the next one nothing is used yet", () => {
  const used = account({ role: "user", tokensPeriod: "2026-11", periodTokens: 9_999_000, tokensUsed: 31_000_000 });
  assert.equal(usedInPeriod(used, NOVEMBER), 9_999_000);
  assert.equal(tokensLeft(used, SETTINGS, NOVEMBER), 1_000);
  assert.equal(usedInPeriod(used, DECEMBER), 0);
  assert.equal(tokensLeft(used, SETTINGS, DECEMBER), 10_000_000);
  // Never below zero, for one that went over with its last request.
  assert.equal(tokensLeft(account({ role: "user", periodTokens: 10_400_000 }), SETTINGS, NOVEMBER), 0);
  assert.equal(usedInPeriod(account({ role: "user", periodTokens: -5 }), NOVEMBER), 0);
  assert.equal(tokensLeft(account({ role: "owner", periodTokens: 10 ** 9 }), SETTINGS, NOVEMBER), null);
});

test("an account is used up when nothing is left this month, and an owner never is", () => {
  const spent = account({ role: "user", periodTokens: 10_000_000 });
  assert.equal(usedUp(spent, SETTINGS, NOVEMBER), true);
  assert.equal(usedUp(spent, SETTINGS, DECEMBER), false);
  assert.equal(usedUp(account({ role: "user", periodTokens: 9_999_999 }), SETTINGS, NOVEMBER), false);
  assert.equal(usedUp(account({ role: "user", tokenAllowance: 0 }), SETTINGS, NOVEMBER), true);
  assert.equal(usedUp(account({ role: "owner", periodTokens: 10 ** 12 }), SETTINGS, NOVEMBER), false);
});

test("the summary of an account, as the pages show it", () => {
  assert.deepEqual(tokenSummary(account({ role: "user", plan: "pro", periodTokens: 5_000_000, tokensUsed: 61_000_000 }), SETTINGS, NOVEMBER), {
    limit: 25_000_000,
    used: 5_000_000,
    left: 20_000_000,
    usedUp: false,
    custom: false,
    total: 61_000_000,
    renewsAt: Date.UTC(2026, 11, 1),
  });
  const own = tokenSummary(account({ role: "user", tokenAllowance: 2_000_000, periodTokens: 2_000_000 }), SETTINGS, NOVEMBER);
  assert.deepEqual([own.limit, own.left, own.usedUp, own.custom], [2_000_000, 0, true, true]);
  const owner = tokenSummary(account({ role: "owner", tokenAllowance: 7, periodTokens: 123, tokensUsed: 456 }), SETTINGS, NOVEMBER);
  assert.deepEqual([owner.limit, owner.left, owner.usedUp, owner.custom, owner.used, owner.total], [null, null, false, false, 123, 456]);
});

test("numbers of tokens are written the same everywhere", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_000), "1,000");
  assert.equal(formatTokens(10_000_000), "10,000,000");
  assert.equal(formatTokens(1_234_567.4), "1,234,567");
});

test("a short number never shows more than there is", () => {
  assert.equal(shortTokens(0), "0");
  assert.equal(shortTokens(9_999), "9,999");
  assert.equal(shortTokens(12_300), "12.3K");
  assert.equal(shortTokens(9_999_999), "9.99M");
  assert.equal(shortTokens(10_000_000), "10M");
  assert.equal(shortTokens(250_000_000), "250M");
  assert.equal(shortTokens(1_500_000_000), "1.5B");
  assert.equal(shortTokens(-5), "0");
});

test("a number of tokens is read as it is typed", () => {
  for (const text of ["10000000", "10,000,000", "10.000.000", "10 000 000", "10_000_000", " 10000000 ", "10M", "10m", "10 jt", "10 juta"]) {
    assert.equal(parseTokens(text), 10_000_000, text);
  }
  assert.equal(parseTokens("250k"), 250_000);
  assert.equal(parseTokens("250 rb"), 250_000);
  assert.equal(parseTokens("2.5M"), 2_500_000);
  assert.equal(parseTokens("2,5 jt"), 2_500_000);
  assert.equal(parseTokens("1B"), 1_000_000_000);
  assert.equal(parseTokens("0"), 0);
  assert.equal(parseTokens(String(MAX_TOKEN_LIMIT)), MAX_TOKEN_LIMIT);
});

test("what is no whole number of tokens is not read as one", () => {
  for (const text of ["", "ten", "-1", "1e9", "12x", String(MAX_TOKEN_LIMIT + 1), "10000000000000000", "1,000k", "M"]) {
    assert.equal(parseTokens(text), null, text);
  }
});

test("the refusal says how much was used, of how much, when there is more, and who can change it", () => {
  const summary = tokenSummary(account({ role: "user", periodTokens: 10_000_000 }), SETTINGS, NOVEMBER);
  assert.equal(
    usedUpMessage(summary),
    "Your tokens for this month are used up: 10,000,000 of 10,000,000 tokens used. They are there again on 1 December; an owner of this installation can give you more.",
  );
  assert.equal(
    usedUpMessage(summary, "project"),
    "The tokens for this month of the account this project belongs to are used up: 10,000,000 of 10,000,000 tokens used. They are there again on 1 December; an owner of this installation can give it more.",
  );
});
