import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_INTERVAL_DEFAULT_MINUTES,
  HEALTH_RETRY_FIRST_MS,
  failureKind,
  healthIntervalMs,
  isDue,
  isFailing,
  nextCheckAt,
  retryDelayMs,
} from "../src/lib/model-health-rules";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SIX_HOURS = 6 * HOUR;

test("without a setting the models are checked every six hours", () => {
  assert.equal(HEALTH_INTERVAL_DEFAULT_MINUTES, 360);
  for (const unset of [undefined, null, "", "  "]) assert.equal(healthIntervalMs(unset), SIX_HOURS);
});

test("the setting is a number of minutes, between five minutes and a week", () => {
  assert.equal(healthIntervalMs("60"), HOUR);
  assert.equal(healthIntervalMs(" 90 "), 90 * MINUTE);
  assert.equal(healthIntervalMs("1"), 5 * MINUTE);
  assert.equal(healthIntervalMs("999999"), 7 * 24 * HOUR);
  assert.equal(healthIntervalMs("12.4"), 12 * MINUTE);
});

test("0 and off switch the automatic check off; what is no number is taken for no setting", () => {
  for (const off of ["0", "off", "OFF", "false", "no"]) assert.equal(healthIntervalMs(off), 0);
  for (const wrong of ["often", "-5", "NaN"]) assert.equal(healthIntervalMs(wrong), SIX_HOURS);
});

test("a model is failing when its last check failed, and only then", () => {
  assert.equal(isFailing({ lastTestStatus: "error" }), true);
  assert.equal(isFailing({ lastTestStatus: "ok" }), false);
  // Never checked: offered, until the first check decides.
  assert.equal(isFailing({ lastTestStatus: null }), false);
});

test("a model that was never checked is due at once", () => {
  const model = { lastTestedAt: null, lastTestStatus: null, checkFailures: 0 };
  assert.equal(nextCheckAt(model, SIX_HOURS), 0);
  assert.equal(isDue(model, 1, SIX_HOURS), true);
});

test("a model that answered is due again after the interval", () => {
  const at = 1_800_000_000_000;
  const model = { lastTestedAt: new Date(at), lastTestStatus: "ok" as const, checkFailures: 0 };
  assert.equal(nextCheckAt(model, SIX_HOURS), at + SIX_HOURS);
  assert.equal(isDue(model, at + SIX_HOURS - 1, SIX_HOURS), false);
  assert.equal(isDue(model, at + SIX_HOURS, SIX_HOURS), true);
  // The time may come as a number too.
  assert.equal(nextCheckAt({ ...model, lastTestedAt: at }, HOUR), at + HOUR);
});

test("a failing model is asked again after 15 minutes, then after twice as long each time, never later than a working one", () => {
  assert.equal(HEALTH_RETRY_FIRST_MS, 15 * MINUTE);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 50].map((failures) => retryDelayMs(failures, SIX_HOURS) / MINUTE),
    [15, 30, 60, 120, 240, 360, 360, 360],
  );
  // A failure that was written down before failures were counted.
  assert.equal(retryDelayMs(0, SIX_HOURS), 15 * MINUTE);
  // An interval shorter than the first wait: the first wait.
  assert.equal(retryDelayMs(3, 5 * MINUTE), 15 * MINUTE);
  const at = 1_800_000_000_000;
  const failing = { lastTestedAt: new Date(at), lastTestStatus: "error" as const, checkFailures: 2 };
  assert.equal(nextCheckAt(failing, SIX_HOURS), at + 30 * MINUTE);
  assert.equal(isDue(failing, at + 29 * MINUTE, SIX_HOURS), false);
  assert.equal(isDue(failing, at + 30 * MINUTE, SIX_HOURS), true);
});

test("with the automatic check off nothing is ever due", () => {
  assert.equal(isDue({ lastTestedAt: null, lastTestStatus: null, checkFailures: 0 }, Date.now(), 0), false);
  assert.equal(isDue({ lastTestedAt: 1, lastTestStatus: "error", checkFailures: 9 }, Date.now(), 0), false);
});

test("a refusal will be a refusal a minute later; a limit, a busy provider and a timeout may be over", () => {
  const kind = (message: string, code?: string) => failureKind({ message, code });
  for (const status of [400, 401, 402, 403, 404, 405, 410, 422]) {
    assert.equal(kind(`Provider responded ${status}: no`), "refused", String(status));
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
    assert.equal(kind(`Provider responded ${status}: wait`), "temporary", String(status));
  }
  assert.equal(kind("The provider did not answer in time", "timeout"), "temporary");
  assert.equal(kind("The provider could not be reached", "network_error"), "temporary");
  // Even when the words name a status.
  assert.equal(kind("Provider responded 404: gone", "timeout"), "temporary");
  // The app did not ask: no key is stored for the provider.
  assert.equal(kind("No API key configured for this provider", "bad_request"), "refused");
  // Something else went wrong on the way: worth a second try.
  assert.equal(kind("Unexpected end of JSON input", "error"), "temporary");
});
