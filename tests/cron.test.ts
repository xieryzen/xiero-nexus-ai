import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CronError,
  describeCron,
  isValidTimeZone,
  nextRun,
  nextRuns,
  parseCron,
  scheduleProblem,
  wallTime,
  zonedTimeToUtc,
} from "../src/lib/cron";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const at = (text: string) => new Date(text);

// ─── Parsing ─────────────────────────────────────────────────────────────────

test("the five fields: lists, ranges, steps and names", () => {
  const spec = parseCron("*/15 9-17 1,15 jan-mar MON-FRI");
  assert.deepEqual(spec.minutes, [0, 15, 30, 45]);
  assert.deepEqual(spec.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...spec.daysOfMonth], [1, 15]);
  assert.deepEqual([...spec.months], [1, 2, 3]);
  assert.deepEqual([...spec.daysOfWeek].sort(), [1, 2, 3, 4, 5]);
  assert.equal(spec.domRestricted, true);
  assert.equal(spec.dowRestricted, true);

  // "5/20" is from 5 to the end in steps of 20; 7 is Sunday, like 0.
  assert.deepEqual(parseCron("5/20 * * * 7").minutes, [5, 25, 45]);
  assert.deepEqual([...parseCron("0 0 * * 7").daysOfWeek], [0]);
  assert.equal(parseCron("  0   8  *  *  * ").domRestricted, false);
});

test("an expression that is not cron says what is wrong", () => {
  const problem = (expression: string, message: RegExp) =>
    assert.throws(() => parseCron(expression), (err: unknown) => err instanceof CronError && message.test(err.message), expression);
  problem("0 8 * *", /five fields/);
  problem("0 8 * * * *", /five fields/);
  problem("60 8 * * *", /outside 0-59/);
  problem("0 24 * * *", /outside 0-23/);
  problem("0 8 0 * *", /outside 1-31/);
  problem("0 8 * 13 *", /outside 1-12/);
  problem("0 8 * * 8", /outside 0-7/);
  problem("0 8 * * funday", /not a valid day of week/);
  problem("*/0 * * * *", /invalid step/);
  problem("5-1 * * * *", /outside/);
  problem("1-2-3 * * * *", /not a valid minute/);
  problem("every morning at eight", /not a valid|five fields/);
});

// ─── Next run ────────────────────────────────────────────────────────────────

test("the next run is strictly after the given time", () => {
  assert.equal(iso(nextRun("0 8 * * *", at("2026-11-12T07:59:00Z"))), "2026-11-12T08:00:00.000Z");
  assert.equal(iso(nextRun("0 8 * * *", at("2026-11-12T08:00:00Z"))), "2026-11-13T08:00:00.000Z");
  assert.equal(iso(nextRun("*/5 * * * *", at("2026-11-12T08:02:30Z"))), "2026-11-12T08:05:00.000Z");
  // Across a month and a year end.
  assert.equal(iso(nextRun("30 23 31 * *", at("2026-12-31T23:30:00Z"))), "2027-01-31T23:30:00.000Z");
});

test("times are read in the schedule's time zone", () => {
  // 08:00 in Jakarta (UTC+7, no daylight saving) is 01:00 UTC.
  assert.equal(iso(nextRun("0 8 * * *", at("2026-11-12T00:00:00Z"), "Asia/Jakarta")), "2026-11-12T01:00:00.000Z");
  assert.equal(iso(nextRun("0 8 * * *", at("2026-11-12T01:00:00Z"), "Asia/Jakarta")), "2026-11-13T01:00:00.000Z");
  // A weekday there can be another day in UTC: Monday 06:00 in Jakarta is Sunday 23:00 UTC.
  assert.equal(iso(nextRun("0 6 * * 1", at("2026-11-12T00:00:00Z"), "Asia/Jakarta")), "2026-11-15T23:00:00.000Z");
  assert.deepEqual(wallTime(Date.UTC(2026, 10, 12, 20, 30), "Asia/Jakarta"), { year: 2026, month: 11, day: 13, hour: 3, minute: 30 });
  assert.throws(() => nextRun("0 8 * * *", new Date(), "Mars/Olympus"), CronError);
});

test("clocks going forward: a time that does not exist is not run", () => {
  // New York, 8 March 2026: 02:00 jumps to 03:00.
  assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York"), null);
  assert.equal(iso(nextRun("30 2 * * *", at("2026-03-07T12:00:00Z"), "America/New_York")), "2026-03-09T06:30:00.000Z");
  // The day before, it runs as usual (07:30 UTC is 02:30 EST).
  assert.equal(iso(nextRun("30 2 * * *", at("2026-03-06T12:00:00Z"), "America/New_York")), "2026-03-07T07:30:00.000Z");
});

test("clocks going back: a time that happens twice runs the first time only", () => {
  // New York, 1 November 2026: 01:30 happens at 05:30 UTC (EDT) and again at 06:30 UTC (EST).
  assert.equal(iso(nextRun("30 1 * * *", at("2026-11-01T04:00:00Z"), "America/New_York")), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(nextRun("30 1 * * *", at("2026-11-01T05:30:00Z"), "America/New_York")), "2026-11-02T06:30:00.000Z");
});

test("when both day fields are set, a day matches if either does", () => {
  // The 13th, and every Friday. From Wednesday 11 November 2026: Friday the 13th first.
  const runs = nextRuns("0 0 13 * 5", at("2026-11-11T00:00:00Z"), "UTC", 4).map(iso);
  assert.deepEqual(runs, ["2026-11-13T00:00:00.000Z", "2026-11-20T00:00:00.000Z", "2026-11-27T00:00:00.000Z", "2026-12-04T00:00:00.000Z"]);
  // With only the day of the week set, the day of the month is free.
  assert.equal(iso(nextRun("0 0 * * 5", at("2026-11-13T00:00:00Z"))), "2026-11-20T00:00:00.000Z");
});

test("29 February is found years ahead; 31 February never comes", () => {
  assert.equal(iso(nextRun("0 0 29 2 *", at("2026-11-12T00:00:00Z"))), "2028-02-29T00:00:00.000Z");
  assert.equal(nextRun("0 0 31 2 *", at("2026-11-12T00:00:00Z")), null);
  assert.deepEqual(nextRuns("0 0 31 2 *", at("2026-11-12T00:00:00Z"), "UTC", 3), []);
});

// ─── Checks and descriptions ─────────────────────────────────────────────────

test("a schedule is checked before it is saved", () => {
  const now = at("2026-11-12T00:00:00Z");
  assert.equal(scheduleProblem("0 8 * * 1-5", "Asia/Jakarta", now), null);
  assert.equal(scheduleProblem("*/5 * * * *", "UTC", now), null);
  assert.equal(scheduleProblem("* * * * *", "UTC", now), "A schedule can run at most every 5 minutes");
  assert.equal(scheduleProblem("0,1 * * * *", "UTC", now), "A schedule can run at most every 5 minutes");
  assert.equal(scheduleProblem("0 0 31 2 *", "UTC", now), "This schedule never runs");
  assert.equal(scheduleProblem("0 8 * * *", "Mars/Olympus", now), '"Mars/Olympus" is not a known time zone');
  assert.match(scheduleProblem("every day", "UTC", now) ?? "", /five fields/);
});

test("time zones are IANA names", () => {
  assert.equal(isValidTimeZone("Asia/Jakarta"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone("x".repeat(65)), false);
});

test("common schedules are described in words; the rest stay as written", () => {
  assert.equal(describeCron("0 8 * * *"), "Every day at 08:00");
  assert.equal(describeCron("30 17 * * 1-5"), "Every weekday at 17:30");
  assert.equal(describeCron("0 9 * * 1"), "Every Monday at 09:00");
  assert.equal(describeCron("0 9 * * 6,0"), "Every Sunday, Saturday at 09:00");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 * * * *"), "Every hour at minute 00");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours at minute 00");
  assert.equal(describeCron("0 9 1 * *"), "On day 1 of every month at 09:00");
  assert.equal(describeCron("0 9 1 1 *"), "0 9 1 1 *");
  assert.equal(describeCron("not cron"), "not cron");
});
