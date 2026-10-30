import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { listWorkRows } from "@/domains/work/queries";
import { getDayPage, getWeekActivity } from "@/domains/daybook/queries";
import { getAuthContext } from "@/lib/auth";
import { PinControls, UnpinButton } from "./pin-controls";
import { buildTimeline, type TimelineRow } from "./timeline";

export const metadata = { title: "Day · Polymath" };

/*
 * The day page (eng review D6/D10; reconciled to the 2026-10-28 mockups): one
 * append-only timeline of what arrived, what changed and what was made, the
 * week strip above it, and the plan / kept / close-the-day sidebar beside it.
 * It is a child of Today — no rail entry — and carries no mutations of its own
 * except pinning (actions.ts). Every row derives from canonical records; each
 * row links the record, never a copy.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function kindPill(kind: string): string {
  switch (kind) {
    case "Captured":
      return "pill-info";
    case "Created":
      return "pill-success";
    case "Changed":
      return "pill-neutral";
    case "Session":
      return "pill-working";
    default:
      return "pill-neutral";
  }
}

function formatTime(at: Date | null): string {
  if (!at) return "";
  return at.toISOString().slice(11, 16);
}

/*
 * The week strip: Mon–Sun cells for the record's week, the viewed day
 * highlighted, each cell's bar weighted to the busiest day. Neighbours link
 * so a day can be walked without touching the URL.
 */
function WeekStrip({ date, days }: { date: string; days: Array<{ date: string; events: number }> }) {
  const busiest = Math.max(1, ...days.map((d) => d.events));
  const index = days.findIndex((d) => d.date === date);
  const prev = index > 0 ? days[index - 1].date : null;
  const next = index >= 0 && index < days.length - 1 ? days[index + 1].date : null;
  const weekday = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const dayNum = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDate();

  return (
    <div className="flex items-start gap-3">
      <div className="panel grid flex-1 grid-cols-7 overflow-hidden rounded-xl max-sm:hidden">
        {days.map((d) => {
          const active = d.date === date;
          const future = d.date > date;
          return (
            <Link
              key={d.date}
              href={`/command-center/day/${d.date}`}
              aria-current={active ? "date" : undefined}
              className={`flex flex-col items-center gap-1 border-border px-2 py-4 text-center transition-colors outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent max-sm:[&:nth-child(n+2)]:border-l [&:nth-child(n+2)]:border-l ${active ? "bg-sidebar-accent" : ""}`}
            >
              <span className={`text-[11px] font-medium uppercase tracking-wide ${active ? "" : future ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
                {weekday(d.date)}
              </span>
              <span className={`text-[15px] font-semibold tabular-nums ${future ? "text-muted-foreground" : ""}`}>
                {dayNum(d.date)}
              </span>
              <span className="mt-1 flex h-3 items-end" aria-hidden>
                <span
                  className={`w-1 rounded-full ${d.events ? "bg-foreground/70" : "bg-border"}`}
                  style={{ height: d.events ? `${Math.max(4, Math.round((d.events / busiest) * 12))}px` : "3px" }}
                />
              </span>
            </Link>
          );
        })}
      </div>
      <div className="flex gap-1.5">
        {prev ? (
          <Button asChild variant="outline" size="icon-sm" aria-label={`Previous day (${prev})`}>
            <Link href={`/command-center/day/${prev}`}><ChevronLeft aria-hidden /></Link>
          </Button>
        ) : (
          <Button variant="outline" size="icon-sm" disabled aria-label="No earlier day in this week"><ChevronLeft aria-hidden /></Button>
        )}
        {next ? (
          <Button asChild variant="outline" size="icon-sm" aria-label={`Next day (${next})`}>
            <Link href={`/command-center/day/${next}`}><ChevronRight aria-hidden /></Link>
          </Button>
        ) : (
          <Button variant="outline" size="icon-sm" disabled aria-label="No later day in this week"><ChevronRight aria-hidden /></Button>
        )}
      </div>
    </div>
  );
}

/*
 * The timeline: a rail of tinted dots, one row per record — time, pill,
 * title, detail. The "Keep" pin control rides inline on rows that can pin
 * (the mockup's Keep on the record), replacing the old keep-something panel.
 */
function Timeline({ rows, localDate }: { rows: TimelineRow[]; localDate: string }) {
  if (!rows.length) return null;
  return (
    <section aria-label="The record" className="panel rounded-xl px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium">
          The record <span className="ml-1 text-muted-foreground">{rows.length}</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">append-only · {rows.length} rows</span>
      </div>
      <ol className="relative">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className={`relative flex gap-3 pb-5 ${index < rows.length - 1 ? "before:absolute before:top-5 before:left-[5px] before:h-[calc(100%-12px)] before:w-px before:bg-border" : ""}`}
          >
            <span aria-hidden className={`relative z-10 mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-background ${row.kind === "Captured" ? "bg-info" : row.kind === "Created" ? "bg-success" : row.kind === "Session" ? "bg-foreground/70" : "bg-muted-foreground/70"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-10 shrink-0 text-[12px] tabular-nums text-muted-foreground">{formatTime(row.at)}</span>
                <span className={`pill ${kindPill(row.kind)}`}>{row.kind}</span>
                {row.kind !== "Captured" ? (
                  <span className="min-w-0 flex-1 break-words text-[13px] font-medium">{row.title}</span>
                ) : null}
                {row.artifactId ? (
                  <span className="shrink-0">
                    <PinControls
                      localDate={localDate}
                      candidates={[{ id: row.artifactId, title: row.title }]}
                    />
                  </span>
                ) : null}
              </div>
              {row.kind === "Captured" ? (
                <p className="mt-2 border-l-2 border-border pl-3 text-[13px] italic leading-relaxed text-muted-foreground line-clamp-2">
                  {row.title}
                </p>
              ) : row.detail ? (
                <p className="mt-1 text-[12px] text-muted-foreground">{row.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-1 border-t border-dashed border-border pt-3 text-[12px] text-muted-foreground">
        The record is append-only. Corrections are new rows, never edits.
      </p>
    </section>
  );
}

async function DaySurface({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  await connection();
  const auth = await getAuthContext();

  if (!DATE_RE.test(date)) {
    return (
      <Screen title="Day">
        <Empty title="That date does not exist" description="Use a date like 2026-10-22." />
      </Screen>
    );
  }

  let day: Awaited<ReturnType<typeof getDayPage>>;
  let week: Array<{ date: string; events: number }>;
  let plan: Awaited<ReturnType<typeof listWorkRows>>;
  try {
    [day, week, plan] = await Promise.all([
      getDayPage(auth, date),
      getWeekActivity(auth, date),
      listWorkRows(auth, "today"),
    ]);
  } catch (error) {
    return (
      <Screen title="Day">
        <Empty
          title="Could not load this day"
          description={error instanceof Error ? error.message : "Something went wrong reading the day."}
        />
      </Screen>
    );
  }

  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const timeline = buildTimeline(day);
  const capturedCount = day.captured.length;

  return (
    <Screen
      title={label}
      description={`One day's record: what arrived, what changed, what was kept. ${capturedCount} ${capturedCount === 1 ? "capture" : "captures"} so far, in order, nothing rewritten.`}
      actions={
        <div className="flex gap-1.5">
          <Button asChild variant="outline" size="sm"><Link href="/command-center/inbox">Back to Inbox</Link></Button>
        </div>
      }
    >
      <WeekStrip date={date} days={week} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {timeline.length ? (
            <Timeline rows={timeline} localDate={date} />
          ) : (
            <Empty
              title={`Nothing recorded on ${label}`}
              description="Work on something and it will show up here."
            />
          )}

          {day.meetings.length ? (
            <Panel title="Meetings" description="Scheduled time this day.">
              <DayItemRows items={day.meetings} />
            </Panel>
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <Panel title="The plan" description="What today was committed to deliver.">
            {plan.length ? (
              <ul className="space-y-3">
                {plan.map((task) => {
                  const hot = task.priority === "high" || task.priority === "urgent";
                  return (
                    <li key={task.id} className="flex items-start gap-2">
                      <span aria-hidden className="mt-1 size-3.5 shrink-0 rounded-[4px] border border-border" />
                      <div className="min-w-0">
                        <Link href={`/neuralflow/work?task=${task.id}`} className="text-[13px] leading-snug hover:underline">
                          {task.title}
                        </Link>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {task.priority !== "none" ? <span className={hot ? "text-destructive" : ""}>{task.priority}</span> : null}
                          {task.dueAt ? <span>{task.priority !== "none" ? " · " : ""}due {task.dueAt.toISOString().slice(0, 10)}</span> : null}
                          {task.priority === "none" && !task.dueAt ? <span>committed</span> : null}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">Nothing committed for today.</p>
            )}
            <div className="mt-4 border-t border-border pt-3">
              <Link href="/neuralflow/work?view=today" className="text-[13px] text-muted-foreground hover:underline">
                Open Work ↗
              </Link>
            </div>
          </Panel>

          <Panel title="Kept" description="Pinned to this day, even as the records change.">
            {day.pins.length ? (
              <div className="divide-y divide-border">
                {day.pins.map((pin) => (
                  <div key={pin.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
                    <span className="text-[13px]">
                      {pin.title}
                      {pin.archived ? " · archived" : ""}
                      {pin.pinnedVersionNumber ? ` · version ${pin.pinnedVersionNumber}` : ""}
                    </span>
                    <UnpinButton localDate={date} artifactId={pin.artifactId} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Nothing kept from this day. Pin a row of the record and it stays here, fixed to the date it happened.
              </p>
            )}
          </Panel>

          <Panel title="Close the day" description="The ritual reads this record, then seeds tomorrow.">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Captures still to clarify</dt>
                <dd className="tabular-nums">{capturedCount}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Committed tasks</dt>
                <dd className="tabular-nums">{plan.length}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Sessions today</dt>
                <dd className="tabular-nums">{day.sessions.length}</dd>
              </div>
            </dl>
            <div className="mt-4">
              <Button asChild className="w-full"><Link href="/command-center/shutdown">Close the day</Link></Button>
            </div>
          </Panel>
        </aside>
      </div>
    </Screen>
  );
}

function DayItemRows({ items }: { items: Array<{ id: string; title: string; at: Date | null }> }) {
  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <div key={item.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
          <span className="text-[13px]">{item.title}</span>
          <span className="text-xs text-muted-foreground">{item.at?.toISOString().slice(11, 16)}</span>
        </div>
      ))}
    </div>
  );
}

/*
 * `connection()` must sit inside a Suspense boundary under cacheComponents,
 * or navigation treats the day as uncached data.
 */
export default function DayPage({ params }: { params: Promise<{ date: string }> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading day…</p>}>
      <DaySurface params={params} />
    </Suspense>
  );
}
