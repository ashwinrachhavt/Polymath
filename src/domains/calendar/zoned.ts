/*
 * Wall-clock time in an IANA zone, for slot search (ASH-282). A fixed UTC
 * offset is wrong the moment a search window crosses a daylight-saving change:
 * 09:00 local is a different instant on each side of it. Everything here
 * converts per date.
 *
 * Two local times are not ordinary on a change day, and both resolve the same
 * way every time:
 *  - a time that does not exist (spring forward, 02:30) lands after the gap,
 *    on the pre-change offset, so it reads 03:30 local;
 *  - a time that happens twice (fall back, 01:30) means the first one.
 * An unknown zone reads as UTC rather than guessing.
 */

const MIN = 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function build(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
}

/** The zone itself when it is a valid IANA name, otherwise "UTC". */
export function resolveZone(timeZone: string): string {
  if (formatters.has(timeZone)) return timeZone;
  try {
    formatters.set(timeZone, build(timeZone));
    return timeZone;
  } catch {
    if (!formatters.has("UTC")) formatters.set("UTC", build("UTC"));
    return "UTC";
  }
}

function parts(at: Date, timeZone: string) {
  const found = formatters.get(resolveZone(timeZone))!.formatToParts(at);
  const n = (type: string) => Number(found.find((p) => p.type === type)?.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** Minutes east of UTC in `timeZone` at the instant `at`. */
export function offsetMinutesAt(timeZone: string, at: Date): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MIN);
}

export type LocalDate = { year: number; month: number; day: number };

/** The calendar date `at` falls on in `timeZone`. */
export function localDate(at: Date, timeZone: string): LocalDate {
  const { year, month, day } = parts(at, timeZone);
  return { year, month, day };
}

/** The date `days` after `date`; month and year roll over. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The instant that reads `minuteOfDay` on `date` in `timeZone`. */
export function wallToUtc(timeZone: string, date: LocalDate, minuteOfDay: number): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + minuteOfDay * MIN;
  const before = offsetMinutesAt(timeZone, new Date(naive - DAY));
  const after = offsetMinutesAt(timeZone, new Date(naive + DAY));
  const candidates = [...new Set([before, after])]
    .map((offset) => naive - offset * MIN)
    .filter((utc) => offsetMinutesAt(timeZone, new Date(utc)) === (naive - utc) / MIN)
    .sort((a, b) => a - b);
  // Empty means the time falls in a gap: use the offset in force before it.
  return new Date(candidates[0] ?? naive - before * MIN);
}

/** "Tue, Oct 27, 10:00 AM" in the zone. */
export function formatLocal(at: Date, timeZone: string): string {
  return at.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: resolveZone(timeZone),
  });
}
