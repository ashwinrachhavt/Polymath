import postgres from "postgres";

/*
 * The automation ticker: fires due project automations once. Called from the
 * cron dispatcher pass, riding the same bearer-authenticated tick.
 *
 * Idempotency is claim-then-start: a due row is claimed with a conditional
 * UPDATE (next_run_at moved before the run starts), so two overlapping ticks
 * cannot both fire it - the second sees next_run_at already advanced. A claim
 * whose engine start fails is logged and skipped; the next cron computes the
 * following slot from the schedule, so a missed run is a missed slot, not a
 * stuck row.
 */

export type TickerResult = { fired: number; failed: number };

type DueRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  prompt: string;
  schedule: string;
  next_run_at: Date | null;
};

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
    const dayMatches = domRestricted && dowRestricted
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

export async function tickAutomations(
  client: postgres.Sql,
  startRun: (input: { workspaceId: string; projectId: string; prompt: string }) => Promise<void>,
  now = new Date(),
  limit = 20,
): Promise<TickerResult> {
  const due = await client<DueRow[]>`
    select id, workspace_id, project_id, prompt, schedule, next_run_at
    from project_automations
    where enabled is true
      and archived_at is null
      and next_run_at is not null
      and next_run_at <= ${now.toISOString()}
    order by next_run_at
    limit ${limit}
  `;

  let fired = 0;
  let failed = 0;
  for (const automation of due) {
    const following = nextCronRun(automation.schedule, now);
    if (!following) {
      // An unscheduleable row would fire forever; disable it so the state is visible.
      await client`update project_automations set enabled = false, updated_at = ${now.toISOString()} where id = ${automation.id}`;
      failed++;
      continue;
    }
    // Claim: only the tick that moves next_run_at fires this row.
    const claimed = await client`
      update project_automations
      set last_run_at = ${now.toISOString()}, next_run_at = ${following.toISOString()}, updated_at = ${now.toISOString()}
      where id = ${automation.id} and next_run_at = ${automation.next_run_at!.toISOString()}
    `;
    if (claimed.count === 0) continue;
    try {
      await startRun({ workspaceId: automation.workspace_id, projectId: automation.project_id, prompt: automation.prompt });
      fired++;
    } catch {
      failed++;
    }
  }
  return { fired, failed };
}
