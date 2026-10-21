/*
 * Local-date helpers for day-boundary logic. "Today", week windows and
 * month windows are computed in the user's saved timezone
 * (userPreferences.timezone), never in UTC: a UTC "today" flips to
 * tomorrow during the user's evening, which made the Today view and the
 * Work calendar show the wrong day after late afternoon in US timezones.
 *
 * Date-only values elsewhere (task due dates) are pinned at noon UTC, so
 * a local date key names the same calendar day as the stored pin for every
 * timezone from UTC-12 to UTC+12.
 */

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function dateKeyInTimezone(date: Date, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(date);
  let year = "0000";
  let month = "01";
  let day = "01";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** Today's date key in `timeZone`. */
export function todayKeyInTimezone(timeZone: string, now: Date = new Date()): string {
  return dateKeyInTimezone(now, timeZone);
}

/** A date key as a Date on the noon-UTC pin (matches stored date-only values). */
export function dateFromKey(key: string): Date {
  return new Date(`${key}T12:00:00Z`);
}

/** The noon-UTC pin's date key, for values stored with that convention. */
export function keyOfPinnedDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Add whole days to a date key. */
export function shiftDateKey(key: string, days: number): string {
  return keyOfPinnedDate(new Date(dateFromKey(key).getTime() + days * DAY_MS));
}

/** First of `key`'s month and first of the next month, as date keys. */
export function monthWindowOf(key: string): { startKey: string; nextStartKey: string } {
  const [year, month] = key.split("-").map(Number);
  const startKey = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextStartKey = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { startKey, nextStartKey };
}

/** Start of the week containing `key`. `weekStart` is an ISO weekday: 1 = Monday, 7 = Sunday. */
export function weekStartKeyOf(key: string, weekStart: number): string {
  const utcDay = dateFromKey(key).getUTCDay();
  const isoDay = utcDay === 0 ? 7 : utcDay;
  return shiftDateKey(key, -((isoDay - weekStart + 7) % 7));
}

/** Weekday of a date key: 0 = Sunday, matching Date.getUTCDay on the noon pin. */
export function weekdayOfKey(key: string): number {
  return dateFromKey(key).getUTCDay();
}
