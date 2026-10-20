/*
 * Free-slot search for time blocking. Pure: callers pass the busy intervals
 * and the working window; no clock, no database.
 */

export type Interval = { start: Date; end: Date };

export type SlotRequest = {
  /** Search starts here (never returns a slot that begins earlier). */
  from: Date;
  minutes: number;
  busy: Interval[];
  /** Working window as minutes since local midnight, in `utcOffsetMinutes`. */
  earliestMinute?: number;
  latestMinute?: number;
  bufferMinutes?: number;
  /** Local offset east of UTC, e.g. -420 for PDT. */
  utcOffsetMinutes?: number;
  /** Give up after this many days. */
  horizonDays?: number;
};

const MIN = 60_000;
const DAY = 86_400_000;

/** First gap of `minutes` inside the working window, padded by the buffer on both sides. */
export function findFreeSlot(req: SlotRequest): Interval | null {
  const earliest = req.earliestMinute ?? 9 * 60;
  const latest = req.latestMinute ?? 18 * 60;
  const buffer = (req.bufferMinutes ?? 0) * MIN;
  const offset = (req.utcOffsetMinutes ?? 0) * MIN;
  const need = req.minutes * MIN;
  if (need <= 0 || latest - earliest < req.minutes) return null;

  const busy = req.busy
    .map((b) => ({ start: b.start.getTime() - buffer, end: b.end.getTime() + buffer }))
    .sort((a, b) => a.start - b.start);

  const fromMs = req.from.getTime();
  const firstDay = Math.floor((fromMs + offset) / DAY);
  for (let d = 0; d < (req.horizonDays ?? 14); d += 1) {
    const dayStart = (firstDay + d) * DAY - offset;
    const windowStart = dayStart + earliest * MIN;
    const windowEnd = dayStart + latest * MIN;
    let cursor = Math.max(windowStart, fromMs);
    for (const b of busy) {
      if (b.end <= cursor) continue;
      if (b.start >= windowEnd) break;
      if (b.start - cursor >= need) break;
      cursor = Math.max(cursor, b.end);
    }
    if (cursor + need <= windowEnd) {
      const blocked = busy.find((b) => b.start < cursor + need && b.end > cursor);
      if (!blocked) return { start: new Date(cursor), end: new Date(cursor + need) };
    }
  }
  return null;
}
