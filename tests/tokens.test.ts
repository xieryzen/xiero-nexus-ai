import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOKEN_LIMIT,
  MAX_TOKEN_LIMIT,
  defaultTokenLimit,
  formatTokens,
  isLimited,
  parseTokens,
  shortTokens,
  tokenSummary,
  tokensLeft,
  usedUp,
  usedUpMessage,
} from "../src/lib/token-rules";

const account = (role: string, tokenLimit: number, tokensUsed: number) => ({ role, tokenLimit, tokensUsed });

test("a new account may use ten million tokens, unless the environment says otherwise", () => {
  assert.equal(DEFAULT_TOKEN_LIMIT, 10_000_000);
  assert.equal(defaultTokenLimit(undefined), 10_000_000);
  assert.equal(defaultTokenLimit(""), 10_000_000);
  assert.equal(defaultTokenLimit("   "), 10_000_000);
  assert.equal(defaultTokenLimit("2500000"), 2_500_000);
  assert.equal(defaultTokenLimit(" 2_500_000 "), 2_500_000);
  assert.equal(defaultTokenLimit("2,500,000"), 2_500_000);
  assert.equal(defaultTokenLimit("0"), 0);
  assert.equal(defaultTokenLimit(String(MAX_TOKEN_LIMIT)), MAX_TOKEN_LIMIT);
});

test("a default that is no whole number of tokens is not used", () => {
  for (const raw of ["-1", "1.5", "ten", "1e30", String(MAX_TOKEN_LIMIT + 1), "NaN", "Infinity"]) {
    assert.equal(defaultTokenLimit(raw), DEFAULT_TOKEN_LIMIT, raw);
  }
});

test("an owner is not held to a limit; an administrator and a user are", () => {
  assert.equal(isLimited("owner"), false);
  assert.equal(isLimited("admin"), true);
  assert.equal(isLimited("user"), true);
  // An account whose role is not known is held to its limit.
  assert.equal(isLimited(undefined), true);
  assert.equal(isLimited("root"), true);
});

test("what is left is the limit less what was used, and never below zero", () => {
  assert.equal(tokensLeft(account("user", 10_000_000, 0)), 10_000_000);
  assert.equal(tokensLeft(account("user", 10_000_000, 1_234_567)), 8_765_433);
  assert.equal(tokensLeft(account("admin", 500, 499)), 1);
  assert.equal(tokensLeft(account("user", 500, 500)), 0);
  // The call that was in progress when the last token went is counted in full.
  assert.equal(tokensLeft(account("user", 500, 750)), 0);
  assert.equal(tokensLeft(account("user", 0, 0)), 0);
  assert.equal(tokensLeft(account("owner", 500, 750)), null);
});

test("an account is used up when nothing is left, and an owner never is", () => {
  assert.equal(usedUp(account("user", 500, 499)), false);
  assert.equal(usedUp(account("user", 500, 500)), true);
  assert.equal(usedUp(account("admin", 500, 9_000)), true);
  assert.equal(usedUp(account("user", 0, 0)), true);
  assert.equal(usedUp(account("owner", 0, 9_000)), false);
});

test("the summary of an account, as the pages show it", () => {
  assert.deepEqual(tokenSummary(account("user", 1_000, 250)), { limit: 1_000, used: 250, left: 750, usedUp: false });
  assert.deepEqual(tokenSummary(account("user", 1_000, 1_200)), { limit: 1_000, used: 1_200, left: 0, usedUp: true });
  // An owner: what was used is counted, and there is no limit to show.
  assert.deepEqual(tokenSummary(account("owner", 1_000, 1_200)), { limit: null, used: 1_200, left: null, usedUp: false });
});

test("numbers of tokens are written the same everywhere", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_000), "1,000");
  assert.equal(formatTokens(10_000_000), "10,000,000");
  assert.equal(formatTokens(1_234_567.4), "1,234,567");
  assert.equal(formatTokens(MAX_TOKEN_LIMIT), "1,000,000,000,000");
});

test("a short number never shows more than there is", () => {
  assert.equal(shortTokens(0), "0");
  assert.equal(shortTokens(9_999), "9,999");
  assert.equal(shortTokens(10_000), "10K");
  assert.equal(shortTokens(12_345), "12.34K");
  assert.equal(shortTokens(999_999), "999.99K");
  assert.equal(shortTokens(1_000_000), "1M");
  assert.equal(shortTokens(9_999_970), "9.99M");
  assert.equal(shortTokens(10_000_000), "10M");
  assert.equal(shortTokens(2_500_000_000), "2.5B");
  assert.equal(shortTokens(-5), "0");
});

test("a number of tokens is read as it is typed, with any thousands separator", () => {
  for (const text of ["10000000", "10,000,000", "10.000.000", "10 000 000", "10_000_000", "  10000000  "]) {
    assert.equal(parseTokens(text), 10_000_000, text);
  }
  assert.equal(parseTokens("0"), 0);
  assert.equal(parseTokens(String(MAX_TOKEN_LIMIT)), MAX_TOKEN_LIMIT);
});

test("what is no whole number of tokens is not read as one", () => {
  for (const text of ["", "   ", "-5", "ten", "10M", "1e6", "+100", String(MAX_TOKEN_LIMIT + 1), "99999999999999"]) {
    assert.equal(parseTokens(text), null, text);
  }
});

test("the refusal says how much was used, of how much, and who can change it", () => {
  const own = usedUpMessage(account("user", 10_000_000, 10_000_123));
  assert.equal(
    own,
    "Your token balance is used up: 10,000,123 of 10,000,000 tokens used. An owner of this installation can raise your limit.",
  );
  const project = usedUpMessage(account("user", 500, 500), "project");
  assert.equal(
    project,
    "The token balance of the account this project belongs to is used up: 500 of 500 tokens used. An owner of this installation can raise its limit.",
  );
});
