import Link from "next/link";
import { listEventsBetween } from "@/domains/calendar/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { listTasksDueBetween } from "@/domains/work/queries";

/*
 * Today's Flow (ASH-185, Dao layout): Upcoming, Focus Windows and Next Events
 * cards beside a month calendar. Every card reads the same canonical tasks and
 * events the week view uses. Days compare in UTC, like the Work calendar.
 */

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">{title}</h2>
      <div className="rounded-2xl border border-border bg-card p-4 text-[13px] shadow-sm">{children}</div>
    </section>
  );
}

function when(d: Date) {
  return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

export async function TodaysFlow({ auth }: { auth: Pick<AuthContext, "workspaceId"> }) {
  const now = new Date();
  const today = iso(now);
  const weekEnd = iso(new Date(now.getTime() + 7 * DAY));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [due, events, monthEvents, monthDue] = await Promise.all([
    listTasksDueBetween(auth, today, weekEnd),
    listEventsBetween(auth, new Date(now.getTime() - DAY), new Date(now.getTime() + 8 * DAY)),
    listEventsBetween(auth, monthStart, nextMonth),
    listTasksDueBetween(auth, iso(monthStart), iso(new Date(nextMonth.getTime() - DAY))),
  ]);

  const upcoming = due.filter((t) => t.status !== "done" && t.status !== "cancelled").slice(0, 5);
  const windows = events.filter((e) => e.taskId && iso(e.startsAt) === today && e.endsAt > now);
  const next = events.filter((e) => !e.taskId && e.endsAt > now).slice(0, 5);

  const marked = new Set<string>([
    ...monthEvents.map((e) => iso(e.startsAt)),
    ...monthDue.filter((t) => t.status !== "done").map((t) => iso(t.dueAt)),
  ]);
  const lead = monthStart.getUTCDay();
  const daysInMonth = Math.round((nextMonth.getTime() - monthStart.getTime()) / DAY);
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" aria-label="Today's Flow">
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Today&apos;s Flow</h2>
          <p className="text-sm text-muted-foreground">
            {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}
          </p>
        </div>
        <Card title="Upcoming">
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground">Nothing upcoming.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {upcoming.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3">
                  <Link href={`/neuralflow/work?view=saved&task=${t.id}`} className="min-w-0 truncate hover:underline">{t.title}</Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{iso(t.dueAt) === today ? "Today" : iso(t.dueAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Focus Windows">
          {windows.length === 0 ? (
            <p className="text-muted-foreground">No focus blocks today.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {windows.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{e.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{when(e.startsAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Next Events">
          {next.length === 0 ? (
            <p className="text-muted-foreground">No upcoming events.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {next.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{e.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{when(e.startsAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <aside className="flex flex-col gap-4">
        <Link
          href="/neuralflow/work?view=board"
          className="self-end rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-accent"
        >
          Open Board
        </Link>
        <section aria-label="Month" className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <p className="text-center text-[15px] font-semibold">
            {monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}
          </p>
          <div className="mt-3 grid grid-cols-7 gap-y-1 text-center text-xs">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
              <span key={d} className="text-muted-foreground">{d}</span>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <span key={`e${i}`} />;
              const key = iso(new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day)));
              const isToday = key === today;
              return (
                <span key={key} className="relative flex h-8 items-center justify-center">
                  <span className={isToday ? "flex size-7 items-center justify-center rounded-full bg-foreground text-background" : ""}>{day}</span>
                  {marked.has(key) && !isToday ? <span aria-hidden className="absolute bottom-0.5 size-1 rounded-full bg-muted-foreground" /> : null}
                </span>
              );
            })}
          </div>
        </section>
      </aside>
    </div>
  );
}
