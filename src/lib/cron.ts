/**
 * Cron schedules: five fields (minute, hour, day of month, month, day of
 * week) read in a time zone. Pure and dependency-free, so it can be
 * unit-tested and used in the browser to show when a schedule fires next.
 *
 *   field          values   also
 *   minute         0-59     *  a,b  a-b  * /n  a-b/n
 *   hour           0-23
 *   day of month   1-31
 *   month          1-12     JAN-DEC
 *   day of week    0-7      SUN-SAT (0 and 7 are Sunday)
 *
 * As in cron, when both day fields are restricted a day matches if either
 * does. A local time that does not exist (the hour skipped when clocks go
 * forward) is not run; one that happens twice runs the first time only.
 */

export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** False when the field is "*". */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class CronError extends Error {}

function parseValue(raw: string, names: string[] | null, nameBase: number, label: string): number {
  const lower = raw.toLowerCase();
  if (names) {
    const index = names.indexOf(lower);
    if (index !== -1) return index + nameBase;
  }
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`"${raw}" is not a valid ${label}`);
  return Number(raw);
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  names: string[] | null = null,
  nameBase = 0,
): { values: number[]; restricted: boolean } {
  const out = new Set<number>();
  if (!field) throw new CronError(`The ${label} field is empty`);
  for (const piece of field.split(",")) {
    const [range, stepRaw, extra] = piece.split("/");
    if (!range || extra !== undefined) throw new CronError(`"${piece}" is not a valid ${label}`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,3}$/.test(stepRaw) || Number(stepRaw) < 1) {
        throw new CronError(`"${piece}" has an invalid step`);
      }
      step = Number(stepRaw);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (!a || !b || more !== undefined) throw new CronError(`"${piece}" is not a valid ${label}`);
      from = parseValue(a, names, nameBase, label);
      to = parseValue(b, names, nameBase, label);
    } else {
      from = parseValue(range, names, nameBase, label);
      // "5/15" means from 5 to the end in steps of 15.
      to = stepRaw !== undefined ? max : from;
    }
    if (from < min || to > max || from > to) {
      throw new CronError(`The ${label} "${piece}" is outside ${min}-${max}`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), restricted: field !== "*" };
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError("A schedule has five fields: minute, hour, day of month, month, day of week");
  }
  const minute = parseField(fields[0]!, 0, 59, "minute");
  const hour = parseField(fields[1]!, 0, 23, "hour");
  const dom = parseField(fields[2]!, 1, 31, "day of month");
  const month = parseField(fields[3]!, 1, 12, "month", MONTHS, 1);
  const dow = parseField(fields[4]!, 0, 7, "day of week", DAYS, 0);
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: new Set(dom.values),
    months: new Set(month.values),
    daysOfWeek: new Set(dow.values.map((d) => (d === 7 ? 0 : d))),
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock time in a zone at an instant. */
export function wallTime(instant: number, timeZone: string): WallTime {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
  };
}

function asUtc(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
}

/** Minutes a zone is ahead of UTC at an instant, as milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const minute = Math.floor(instant / 60_000) * 60_000;
  return asUtc(wallTime(minute, timeZone)) - minute;
}

/**
 * The instant at which a zone's clocks show the given wall time: the earlier
 * one when it happens twice, null when it does not happen at all.
 */
export function zonedTimeToUtc(wall: WallTime, timeZone: string): number | null {
  const target = asUtc(wall);
  // The offsets on either side of any change near this time.
  const offsets = new Set([
    offsetAt(target - 24 * 3_600_000, timeZone),
    offsetAt(target, timeZone),
    offsetAt(target + 24 * 3_600_000, timeZone),
  ]);
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((instant) => asUtc(wallTime(instant, timeZone)) === target)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const dom = spec.daysOfMonth.has(day);
  const dow = spec.daysOfWeek.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

/** How far ahead a next run is looked for: covers "29 February". */
const SEARCH_DAYS = 366 * 8 + 2;

/**
 * The first time a schedule fires strictly after `after`, or null when it
 * never does (such as 31 February).
 */
export function nextRun(expression: string | CronSpec, after: Date, timeZone = "UTC"): Date | null {
  const spec = typeof expression === "string" ? parseCron(expression) : expression;
  if (!isValidTimeZone(timeZone)) throw new CronError(`"${timeZone}" is not a known time zone`);
  const afterMs = after.getTime();
  const start = wallTime(afterMs, timeZone);
  // Walk whole local days, as dates, so that month ends need no special care.
  const firstDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const date = new Date(firstDay + i * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dayMatches(spec, year, month, day)) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const instant = zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);
        if (instant !== null && instant > afterMs) return new Date(instant);
      }
    }
  }
  return null;
}

/** The next `count` times a schedule fires after `after`. */
export function nextRuns(expression: string, after: Date, timeZone: string, count: number): Date[] {
  const spec = parseCron(expression);
  const out: Date[] = [];
  let from = after;
  for (let i = 0; i < count; i++) {
    const next = nextRun(spec, from, timeZone);
    if (!next) break;
    out.push(next);
    from = next;
  }
  return out;
}

/** The shortest time between two runs a schedule may have. Every run costs tokens. */
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;

/**
 * Check a schedule before it is saved. Returns what is wrong with it, or null.
 */
export function scheduleProblem(expression: string, timeZone: string, now = new Date()): string | null {
  try {
    if (!isValidTimeZone(timeZone)) return `"${timeZone}" is not a known time zone`;
    const runs = nextRuns(expression, now, timeZone, 4);
    if (runs.length === 0) return "This schedule never runs";
    for (let i = 1; i < runs.length; i++) {
      if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_SCHEDULE_INTERVAL_MS) {
        return "A schedule can run at most every 5 minutes";
      }
    }
    return null;
  } catch (err) {
    return err instanceof CronError ? err.message : "Invalid schedule";
  }
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A schedule in words, for the common shapes; otherwise the expression itself. */
export function describeCron(expression: string): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expression);
  } catch {
    return expression;
  }
  const fields = expression.trim().split(/\s+/);
  const everyMonth = fields[3] === "*";
  const oneTime = spec.hours.length === 1 && spec.minutes.length === 1;
  const at = oneTime ? `${two(spec.hours[0]!)}:${two(spec.minutes[0]!)}` : null;

  if (everyMonth && !spec.domRestricted && !spec.dowRestricted) {
    if (at) return `Every day at ${at}`;
    const step = fields[0]!.match(/^\*\/(\d+)$/);
    if (step && fields[1] === "*") return `Every ${step[1]} minutes`;
    const hourStep = fields[1]!.match(/^\*\/(\d+)$/);
    if (hourStep && spec.minutes.length === 1) {
      return `Every ${hourStep[1]} hours at minute ${two(spec.minutes[0]!)}`;
    }
    if (fields[1] === "*" && spec.minutes.length === 1) {
      return `Every hour at minute ${two(spec.minutes[0]!)}`;
    }
  }
  if (everyMonth && at && spec.dowRestricted && !spec.domRestricted) {
    const days = [...spec.daysOfWeek].sort((a, b) => a - b);
    if (days.join(",") === "1,2,3,4,5") return `Every weekday at ${at}`;
    return `Every ${days.map((d) => DAY_NAMES[d]).join(", ")} at ${at}`;
  }
  if (everyMonth && at && spec.domRestricted && !spec.dowRestricted) {
    const days = [...spec.daysOfMonth].sort((a, b) => a - b);
    return `On day ${days.join(", ")} of every month at ${at}`;
  }
  return expression;
}
