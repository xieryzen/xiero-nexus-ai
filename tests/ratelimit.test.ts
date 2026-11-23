import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, rateLimitFull, rateLimitReset } from "../src/lib/ratelimit";
import { FAILED_KEEPS_MAX, FAILED_KEEPS_WINDOW_MS, KEEPS_PER_MINUTE } from "../src/lib/access/rules";

test("a bucket takes its limit of calls in a window, and no more", () => {
  const key = `test:${Math.random()}`;
  for (let i = 0; i < 3; i++) assert.equal(rateLimit(key, 3, 60_000).ok, true);
  const over = rateLimit(key, 3, 60_000);
  assert.equal(over.ok, false);
  assert.equal(over.retryAfterMs > 0 && over.retryAfterMs <= 60_000, true);
  rateLimitReset(key);
  assert.equal(rateLimit(key, 3, 60_000).ok, true);
});

test("asking whether a bucket is full counts nothing", () => {
  const key = `test:${Math.random()}`;
  // Nothing was counted yet: asking does not start a window either.
  for (let i = 0; i < 10; i++) assert.deepEqual(rateLimitFull(key, 2), { ok: true, remaining: 2, retryAfterMs: 0 });
  rateLimit(key, 2, 60_000);
  assert.equal(rateLimitFull(key, 2).remaining, 1);
  rateLimit(key, 2, 60_000);
  for (let i = 0; i < 10; i++) assert.equal(rateLimitFull(key, 2).ok, false);
  assert.equal(rateLimitFull(key, 2).retryAfterMs > 0, true);
  // A window that is over is empty again.
  const short = `test:${Math.random()}`;
  rateLimit(short, 1, -1);
  assert.equal(rateLimitFull(short, 1).ok, true);
});

test("sign-ins that fail are limited more tightly than sign-ins that are tried", () => {
  assert.equal(FAILED_KEEPS_MAX < KEEPS_PER_MINUTE, true);
  assert.equal(FAILED_KEEPS_WINDOW_MS >= 10 * 60_000, true);
});
