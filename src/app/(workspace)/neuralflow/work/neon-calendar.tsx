import Link from "next/link";
import { connection } from "next/server";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { listTasksDueBetween, type DatedTask } from "@/domains/work/queries";

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
  const rows = await listTasksDueBetween(auth, iso(days[0]), iso(days[6]));
  const byDay = new Map<string, DatedTask[]>();
  for (const row of rows) {
    const key = iso(row.dueAt);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  const base = "/neuralflow/work?view=calendar";

  return (
    <Screen
      title="Work calendar"
      description="Saved tasks by due date. Set or move a due date from the task card; undated work stays on the list and board."
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
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
        {days.map((day) => {
          const key = iso(day);
          const due = byDay.get(key) ?? [];
          return (
            <Panel
              key={key}
              title={day.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}
              description={key === today ? `${key}; today` : key}
            >
              {due.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing due.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {due.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <Link href={`/neuralflow/work?view=saved&task=${row.id}`} className="min-w-0 truncate hover:underline">
                        {row.title}
                      </Link>
                      <Status>{row.status === "done" || row.status === "cancelled" ? row.status : "due"}</Status>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <Empty
          title="No saved tasks due this week"
          description="Open a task from the list and give it a due date to place it here."
          action={<Link href="/neuralflow/work?view=saved" className="underline underline-offset-4">Open the saved list</Link>}
        />
      ) : null}
    </Screen>
  );
}
