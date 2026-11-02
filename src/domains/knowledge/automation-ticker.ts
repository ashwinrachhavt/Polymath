/*
 * Cron evaluation for the automation scheduler: find the next UTC fire time
 * of a five-field (minute hour day-of-month month day-of-week) expression.
 */

/** The next UTC time a five-field cron expression fires after `after`. */
export function nextCronRun(expression: string, after: Date): Date | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  // Standard cron: when one of day-of-month and day-of-week is `*`, the other
  // restricts; when both are restricted, a match on either fires.
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const parseField = (field: string, min: number, max: number): Set<number> | null => {
    const values = new Set<number>();
    for (const part of field.split(",")) {
      const [range, stepRaw] = part.split("/");
      const step = stepRaw ? Number(stepRaw) : 1;
      if (!Number.isInteger(step) || step < 1) return null;
      let lo: number;
      let hi: number;
      if (range === "*") {
        lo = min;
        hi = max;
      } else if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) return null;
        lo = a;
        hi = b;
      } else {
        const v = Number(range);
        if (!Number.isInteger(v) || v < min || v > max) return null;
        lo = v;
        hi = stepRaw ? max : v;
      }
      for (let value = lo; value <= hi; value += step) values.add(value);
    }
    return values.size > 0 ? values : null;
  };
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const daysOfMonth = parseField(dom, 1, 31);
  const months = parseField(month, 1, 12);
  // 0 = Sunday.
  const daysOfWeek = parseField(dow === "7" ? "0" : dow, 0, 6);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  // Scan forward minute by minute, at most 366 days. Cron is UTC; the getters
  // must be too, or a non-UTC server shifts every match by its offset.
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const end = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (cursor <= end) {
    const dayMatches =
      domRestricted && dowRestricted
        ? daysOfMonth.has(cursor.getUTCDate()) || daysOfWeek.has(cursor.getUTCDay())
        : domRestricted
          ? daysOfMonth.has(cursor.getUTCDate())
          : daysOfWeek.has(cursor.getUTCDay());
    if (
      months.has(cursor.getUTCMonth() + 1) &&
      hours.has(cursor.getUTCHours()) &&
      minutes.has(cursor.getUTCMinutes()) &&
      dayMatches
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
