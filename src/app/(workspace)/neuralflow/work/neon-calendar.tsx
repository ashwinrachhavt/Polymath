import Link from "next/link";
import { connection } from "next/server";
import { Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { listEventsBetween } from "@/domains/calendar/queries";
import { listTasksDueBetweenForPage } from "./data";
import { listPendingCalendarProposals } from "@/domains/calendar/proposals";
import { CalendarToolbar } from "./calendar-assist";
import { WeekGrid } from "./week-grid";

/*
 * The Work calendar on Neon: saved tasks laid out by due date, one week at a
 * time. Days compare in UTC, matching the task card's noon-UTC due dates.
 * Provider events and local time blocks are the preview calendar's business;
 * this screen answers one question: what saved work is due when.
 */

const DAY = 86_400_000;

function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function NeonCalendar({ date }: { date?: string }) {
  await connection();
  const auth = await getAuthContext();
  const today = iso(new Date());
  const anchor = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const anchorDate = new Date(`${anchor}T12:00:00Z`);
  // Weeks start Monday, matching the preview calendar's default preference.
  const start = new Date(anchorDate.getTime() - ((anchorDate.getUTCDay() + 6) % 7) * DAY);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY));
  const rows = await listTasksDueBetweenForPage(auth, iso(days[0]), iso(days[6]));
  // Pad a day each side so blocks near midnight survive any browser zone.
  const events = await listEventsBetween(auth, new Date(start.getTime() - DAY), new Date(start.getTime() + 8 * DAY));
  const proposals = await listPendingCalendarProposals(auth);
  const blocked = new Set(events.map((e) => e.taskId).filter(Boolean));
  const unscheduled = rows
    .filter((r) => r.status !== "done" && r.status !== "cancelled" && !blocked.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, estimateMinutes: r.estimateMinutes, done: false }));
  const base = "/neuralflow/work?view=calendar";

  return (
    <Screen
      title="Week"
      description="Your week as time blocks. Block time for a task and it lands in the first free slot of your working hours."
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Link className="rounded-md border border-border px-2.5 py-1 hover:bg-accent" href={`${base}&date=${iso(new Date(start.getTime() - 7 * DAY))}`}>
          Previous week
        </Link>
        <Link className="rounded-md border border-border px-2.5 py-1 hover:bg-accent" href={base}>
          This week
        </Link>
        <Link className="rounded-md border border-border px-2.5 py-1 hover:bg-accent" href={`${base}&date=${iso(new Date(start.getTime() + 7 * DAY))}`}>
          Next week
        </Link>
        <span className="readout text-xs text-muted-foreground">
          {iso(days[0])} to {iso(days[6])}
        </span>
      </div>
      <CalendarToolbar
        events={events.map((e) => ({ title: e.title, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), taskId: e.taskId }))}
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
