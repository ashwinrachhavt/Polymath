import Link from "next/link";
import { io } from "next/cache";
import { Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { listEventsBetween } from "@/domains/calendar/queries";
import { getPreferences } from "@/domains/identity/preferences";
import { dateFromKey, monthWindowOf, shiftDateKey, todayKeyInTimezone, weekStartKeyOf } from "@/lib/local-date";
import { listTasksDueBetweenForPage } from "./data";
import { listPendingCalendarProposals } from "@/domains/calendar/proposals";
import { CalendarToolbar } from "./calendar-assist";
import { WeekGrid } from "./week-grid";

const DAY = 86_400_000;
const LOCALE = "en-US";

function MonthTasks({
  startKey,
  monthKey,
  todayKey,
  rows,
}: {
  startKey: string;
  monthKey: string;
  todayKey: string;
  rows: Awaited<ReturnType<typeof listTasksDueBetweenForPage>>;
}) {
  const days = Array.from({ length: 42 }, (_, index) => shiftDateKey(startKey, index));
  const weekDays = days
    .slice(0, 7)
    .map((key) =>
      new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`)),
    );
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.dueAt.toISOString().slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <div className="grid min-w-[640px] grid-cols-7">
        {weekDays.map((day) => (
          <div key={day} className="border-b border-border px-2 py-2 text-xs font-medium text-muted-foreground">
            {day}
          </div>
        ))}
        {days.map((key) => {
          const dayRows = byDay.get(key) ?? [];
          const currentMonth = key.startsWith(monthKey);
          const today = key === todayKey;
          return (
            <section
              key={key}
              aria-label={key}
              className={`min-h-24 border-r border-b border-border p-1.5 last:border-r-0 sm:min-h-28 sm:p-2 ${currentMonth ? "" : "bg-muted/20"}`}
            >
              <div
                className={`mb-1 flex size-6 items-center justify-center rounded-full text-xs tabular-nums ${today ? "bg-primary text-primary-foreground" : currentMonth ? "text-foreground" : "text-muted-foreground"}`}
              >
                {key.slice(-2).replace(/^0/, "")}
              </div>
              <ul className="flex flex-col gap-1">
                {dayRows.slice(0, 3).map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/neuralflow/work?view=saved&task=${task.id}`}
                      title={task.title}
                      className={`block truncate rounded-md border border-border/70 bg-card px-1.5 py-1 text-[11px] leading-tight transition-colors hover:border-primary/40 hover:bg-muted/60 ${task.status === "done" ? "text-muted-foreground line-through" : ""}`}
                    >
                      {task.title}
                    </Link>
                  </li>
                ))}
                {dayRows.length > 3 ? (
                  <li className="px-1 text-[10px] text-muted-foreground">+{dayRows.length - 3} more</li>
                ) : null}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export async function NeonCalendar({ date, mode = "week" }: { date?: string; mode?: "week" | "month" }) {
  await io();
  const auth = await getAuthContext();
  const { timezone, weekStart } = await getPreferences(auth);
  const today = todayKeyInTimezone(timezone);
  const anchor = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const base = "/neuralflow/work?view=calendar";
  const month = monthWindowOf(anchor);
  const monthGridStart = weekStartKeyOf(month.startKey, weekStart);
  const monthGridEnd = shiftDateKey(monthGridStart, 41);

  if (mode === "month") {
    const rows = (await listTasksDueBetweenForPage(auth, monthGridStart, monthGridEnd)).filter(
      (row) => row.status !== "cancelled",
    );
    const headingDate = dateFromKey(month.startKey);
    const monthLabel = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      headingDate,
    );
    return (
      <Screen title={monthLabel}>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
            href={`${base}&mode=month&date=${shiftDateKey(month.startKey, -1)}`}
          >
            Previous month
          </Link>
          <Link
            className="rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
            href={`${base}&mode=month`}
          >
            Today
          </Link>
          <Link
            className="rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
            href={`${base}&mode=month&date=${month.nextStartKey}`}
          >
            Next month
          </Link>
          <div className="ml-auto inline-flex rounded-lg border border-border p-0.5 text-sm" aria-label="Calendar view">
            <Link
              className="rounded-md px-3 py-1 text-muted-foreground transition-colors hover:text-foreground"
              href={`${base}&mode=week&date=${anchor}`}
            >
              Week
            </Link>
            <span aria-current="page" className="rounded-md bg-muted px-3 py-1 font-medium">
              Month
            </span>
          </div>
        </div>
        <MonthTasks startKey={monthGridStart} monthKey={month.startKey.slice(0, 7)} todayKey={today} rows={rows} />
        <p className="text-xs text-muted-foreground">Select a task to see its details and change its due date.</p>
      </Screen>
    );
  }

  const startKey = weekStartKeyOf(anchor, weekStart);
  const endKey = shiftDateKey(startKey, 6);
  const start = dateFromKey(startKey);
  const rows = await listTasksDueBetweenForPage(auth, startKey, endKey);
  // Pad a day each side so blocks near midnight survive any browser zone.
  const events = await listEventsBetween(auth, new Date(start.getTime() - DAY), new Date(start.getTime() + 8 * DAY));
  const proposals = await listPendingCalendarProposals(auth);
  const blocked = new Set(events.map((e) => e.taskId).filter(Boolean));
  const unscheduled = rows
    .filter((r) => r.status !== "done" && r.status !== "cancelled" && !blocked.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, estimateMinutes: r.estimateMinutes, done: false }));

  return (
    <Screen title="Week">
      <div className="flex flex-wrap items-center gap-2 text-body-dense">
        <Link
          className="rounded-md border border-border px-2.5 py-1.5 transition-colors hover:bg-muted"
          href={`${base}&date=${shiftDateKey(startKey, -7)}`}
        >
          Previous week
        </Link>
        <Link className="rounded-md border border-border px-2.5 py-1.5 transition-colors hover:bg-muted" href={base}>
          This week
        </Link>
        <Link
          className="rounded-md border border-border px-2.5 py-1.5 transition-colors hover:bg-muted"
          href={`${base}&date=${shiftDateKey(startKey, 7)}`}
        >
          Next week
        </Link>
        <span className="readout text-xs text-muted-foreground">
          {startKey} to {endKey}
        </span>
        <div className="ml-auto inline-flex rounded-lg border border-border p-0.5 text-sm" aria-label="Calendar view">
          <span aria-current="page" className="rounded-md bg-muted px-3 py-1 font-medium">
            Week
          </span>
          <Link
            className="rounded-md px-3 py-1 text-muted-foreground transition-colors hover:text-foreground"
            href={`${base}&mode=month&date=${anchor}`}
          >
            Month
          </Link>
        </div>
        <Link
          className="py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          href="/neuralflow/work?view=today"
        >
          Meetings
        </Link>
      </div>
      <CalendarToolbar
        events={events.map((e) => ({
          title: e.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          taskId: e.taskId,
        }))}
        proposals={proposals}
      />
      <WeekGrid
        weekStartMs={start.getTime()}
        events={events.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          version: e.version,
          taskId: e.taskId,
        }))}
        unscheduled={unscheduled}
      />
    </Screen>
  );
}
