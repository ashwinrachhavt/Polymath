import Link from "next/link";
import { io } from "next/cache";
import { Empty, Panel, Screen, StatStrip } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { CalendarDays, CircleDashed } from "lucide-react";
import { WORK_OPEN_STATUSES, WORK_PRIORITIES, type DatedTask, type WorkRow } from "@/domains/work/queries";
import {
  getTaskDetailForPage,
  getActiveFocusSessionForPage,
  listFocusHistoryForPage,
  countWorkByStatusForPage,
  listWorkPageForPage,
  listWorkRowsForPage,
  listTasksDueBetweenForPage,
} from "./data";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { getTaskProvenance } from "@/domains/knowledge/queries";
import { TaskCard } from "./task-controls";
import { FocusTaskButton } from "./focus-controls";
import { TaskEvidence } from "./task-evidence";
import { CommitList, WorkList } from "./work-list";
import { DayStrip } from "./day-strip";
import { SeedSuggestions } from "./seed-suggestions";
import { listSeedsForDay } from "@/domains/work/seeds";
import { shiftDateKey, todayKeyInTimezone } from "@/lib/local-date";
import { getPreferences } from "@/domains/identity/preferences";

/*
 * The Work list on Neon. Server component: reads through the work domain's
 * queries, never the preview store.
 *
 * The screen answers one question - what am I committed to today, and what is
 * the single next thing to start - and the committed list is the block that
 * answers it. Everything under it is the path into today (Next up, Inbox),
 * and the day's schedule is one line above the list rather than four cards
 * below it.
 *
 * Today is the owner's explicit commitment (Ready or In progress); Open is
 * everything unfinished; Done is finished work.
 */

const statusLabel: Record<WorkRow["status"], string> = {
  inbox: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

export type Scope = "today" | "open" | "done";

function scopeOf(show: string | undefined): Scope {
  return show === "today" || show === "done" ? show : "open";
}

const BASE = "/neuralflow/work";
const UUID = /^[0-9a-f-]{36}$/i;

function dueDateLabel(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function dueDay(task: DatedTask) {
  return task.dueAt.toISOString().slice(0, 10);
}

export async function NeonTasks({
  show,
  selectedTask,
  raw = {},
}: {
  show?: string;
  selectedTask?: string;
  /** The page's search params, so filters and the pager keep each other's state. */
  raw?: RawSearchParams;
}) {
  // Per-user data: render at request time, never prerender.
  await io();
  const auth = await getAuthContext();
  const scope = scopeOf(show);
  const statusChoices =
    scope === "today" ? (["ready", "in_progress"] as const) : scope === "open" ? WORK_OPEN_STATUSES : ([] as const);
  const list = parseListParams(raw, { filters: { priority: WORK_PRIORITIES, status: statusChoices } });
  const filtered = Boolean(list.q || list.filters.priority || list.filters.status);
  const validSelection = selectedTask && UUID.test(selectedTask) ? selectedTask : undefined;

  // Start the independent page reads together; the timezone only gates
  // timezone-specific day suggestions and deadline grouping.
  const [preferences, found, openRows, counts, activeSession] = await Promise.all([
    getPreferences(auth),
    listWorkPageForPage(auth, scope, {
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
      query: list.q || undefined,
      priority: list.filters.priority as (typeof WORK_PRIORITIES)[number] | undefined,
      status: list.filters.status as (typeof WORK_OPEN_STATUSES)[number] | undefined,
    }),
    listWorkRowsForPage(auth, "open"),
    countWorkByStatusForPage(auth),
    getActiveFocusSessionForPage(auth),
  ]);
  const today = todayKeyInTimezone(preferences.timezone);
  const [seeds, datedTasks] = await Promise.all([
    scope === "today" ? listSeedsForDay(auth, today).catch(() => []) : Promise.resolve([]),
    scope === "today"
      ? listTasksDueBetweenForPage(auth, shiftDateKey(today, -30), shiftDateKey(today, 14))
      : Promise.resolve([]),
  ]);
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const rows = found.rows;

  // The inspector never sits empty: with no explicit selection it shows the
  // first committed task, which is also the row the owner is most likely to
  // start. A filtered or empty list falls back to no detail rather than a
  // task the list is not showing.
  const detailId = validSelection;
  const [detail, focusHistory] = await Promise.all([
    detailId ? getTaskDetailForPage(auth, detailId) : null,
    detailId ? listFocusHistoryForPage(auth, 5, detailId) : [],
  ]);
  const [provenance] = await Promise.all([detail ? getTaskProvenance(auth, detail.task.id) : []]);
  const candidates = detail
    ? openRows.filter((r) => r.id !== detail.task.id).map((r) => ({ id: r.id, title: r.title }))
    : [];

  // The path into today: open work that is not already a commitment, then
  // whatever was captured and never triaged. Both are counts of real rows, and
  // both disappear once there is nothing left to commit.
  const committedIds = new Set(
    openRows.filter((r) => r.status === "ready" || r.status === "in_progress").map((r) => r.id),
  );
  // A suggested task is offered once, by the suggestion: the same row in Next
  // up would be two controls for one decision, and the owner would see the
  // task they are deciding about twice before deciding.
  const suggestedIds = new Set(seeds.map((seed) => seed.taskId));
  const deadlineIds = new Set(
    datedTasks.filter((task) => task.status !== "done" && task.status !== "cancelled").map((task) => task.id),
  );
  const nextUp = openRows
    .filter((r) => !committedIds.has(r.id) && !suggestedIds.has(r.id) && !deadlineIds.has(r.id))
    .slice(0, 5);
  const inboxCount = counts.inbox;

  const hrefFor = (id: string) => listHref(BASE, raw, { view: "saved", task: id });
  const scopeLabel = scope === "today" ? "committed" : scope === "open" ? "open" : "finished";
  // "Inbox" on Today is the triage count, not the rows: captured work is
  // triaged on Inbox, and this screen's job is to say how much is waiting.
  const nextUpCount = nextUp.length;
  const dueTasks = datedTasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  const overdueTasks = dueTasks.filter((task) => dueDay(task) < today);
  const dueTodayTasks = dueTasks.filter((task) => dueDay(task) === today);
  const upcomingTasks = dueTasks.filter((task) => dueDay(task) > today);
  const overdueDeadlines = overdueTasks.slice(0, 4);
  const dueTodayDeadlines = dueTodayTasks.slice(0, 4);
  const upcomingDeadlines = upcomingTasks.slice(0, 6);
  const deadlineTotal = overdueTasks.length + dueTodayTasks.length + upcomingTasks.length;
  const renderDeadlineGroup = (label: string, tasks: DatedTask[], tone = "text-muted-foreground") =>
    tasks.length ? (
      <section aria-label={label}>
        <h3 className={`mb-1.5 text-xs font-medium ${tone}`}>
          {label} <span className="readout">· {tasks.length}</span>
        </h3>
        <ul className="divide-y divide-border/60">
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                href={`/neuralflow/work?view=saved&task=${task.id}`}
                className="group flex min-w-0 items-center gap-2.5 py-2.5 first:pt-1"
              >
                <CircleDashed aria-hidden className={`size-3.5 shrink-0 ${tone}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium group-hover:text-primary">{task.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {task.projectName ?? "Unassigned project"}
                  </span>
                </span>
                <time className={`readout shrink-0 text-xs ${tone}`} dateTime={task.dueAt.toISOString()}>
                  {dueDateLabel(task.dueAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <Screen
      title={scope === "today" ? "Work" : scope === "done" ? "Finished" : "Tasks"}
      description={scope === "today" ? "Your day, at a glance." : undefined}
      actions={
        // The live session's controls live on Focus now; this entry points at
        // its setup when nothing is running.
        <Link
          href="/neuralflow/focus"
          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-label text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          New session
        </Link>
      }
    >
      {scope === "today" ? <DayStrip auth={auth} /> : null}

      {/* The pipeline strip (mockup 2026-10-28): one panel, six stages, each
          a count of real rows. Where the work is in its life, at a glance. */}
      {scope === "today" ? (
        <StatStrip
          className="grid-cols-2 sm:grid-cols-4"
          items={[
            { label: "Committed", value: found.total, hint: "Work you have taken on today." },
            { label: "Due today", value: dueTodayTasks.length, hint: "Open tasks with today's deadline." },
            { label: "Overdue", value: overdueTasks.length, hint: "Past-due open work." },
            { label: "Inbox", value: counts.inbox, hint: "Waiting to be clarified." },
          ]}
        />
      ) : null}

      <div
        className={`grid items-start gap-5 ${detail || scope === "today" ? "xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]" : "grid-cols-1"}`}
      >
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2">
            <h2 className="text-body font-medium">
              {scope === "today" ? "Today" : scope === "done" ? "Finished" : "Open"}
            </h2>
            <span className="readout text-label text-muted-foreground">
              {found.total} {scopeLabel}
            </span>
            <nav aria-label="Saved task filter" className="ml-auto flex gap-3 text-label">
              <Link
                className={scope === "today" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                href={listHref(BASE, raw, {
                  view: "saved",
                  show: "today",
                  status: undefined,
                  page: undefined,
                  task: undefined,
                })}
                aria-current={scope === "today" ? "page" : undefined}
              >
                Today
              </Link>
              <Link
                className={scope === "open" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                href={listHref(BASE, raw, {
                  view: "saved",
                  show: undefined,
                  status: undefined,
                  page: undefined,
                  task: undefined,
                })}
                aria-current={scope === "open" ? "page" : undefined}
              >
                Open
              </Link>
              <Link
                className={scope === "done" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                href={listHref(BASE, raw, {
                  view: "saved",
                  show: "done",
                  status: undefined,
                  page: undefined,
                  task: undefined,
                })}
                aria-current={scope === "done" ? "page" : undefined}
              >
                Finished
              </Link>
            </nav>
          </div>

          <div className="mb-3">
            <ListToolbar
              searchPlaceholder="Search tasks"
              filters={[
                ...(statusChoices.length
                  ? [
                      {
                        key: "status",
                        label: "State",
                        allLabel: "Any state",
                        options: statusChoices.map((v) => ({ value: v, label: statusLabel[v] })),
                      },
                    ]
                  : []),
                {
                  key: "priority",
                  label: "Priority",
                  allLabel: "Any priority",
                  options: WORK_PRIORITIES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })),
                },
              ]}
              total={found.total}
              noun={found.total === 1 ? "task" : "tasks"}
            />
          </div>

          {scope === "today" && !filtered ? <SeedSuggestions seeds={seeds} /> : null}

          <WorkList
            addToToday={scope === "today"}
            emptyState={
              <NoResults
                filtered={filtered}
                clearHref={listHref(BASE, raw, {
                  q: undefined,
                  status: undefined,
                  priority: undefined,
                  page: undefined,
                })}
                emptyTitle={
                  scope === "today"
                    ? "Nothing committed for today"
                    : scope === "done"
                      ? "No finished tasks yet"
                      : "No open tasks"
                }
                emptyDescription={
                  scope === "today" ? "Add a task above and it lands here. Or commit one from Inbox below." : undefined
                }
              />
            }
            items={rows.map((row) => ({
              row: {
                id: row.id,
                title: row.title,
                projectName: row.projectName,
                status: row.status,
                priority: row.priority,
                dueAt: row.dueAt ? row.dueAt.toISOString() : null,
                version: row.version,
                subtaskCount: row.subtaskCount,
                subtasksDone: row.subtasksDone,
                blockedBy: row.blockedBy,
              },
              href: hrefFor(row.id),
              selected: detail?.task.id === row.id,
            }))}
          />
          <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} />

          {scope === "today" ? (
            <nav aria-label="Related tools" className="mt-5 flex flex-wrap gap-x-4 text-data text-muted-foreground">
              <Link className="py-1 hover:text-foreground hover:underline" href="/command-center/inbox">
                Brain dump
              </Link>
              <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/reports">
                Weekly review
              </Link>
              <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/rewards">
                Stone collection
              </Link>
            </nav>
          ) : null}
        </div>

        {detail ? (
          <Panel title="Task details" className="xl:sticky xl:top-4">
            {detail ? (
              <TaskCard
                data={{
                  id: detail.task.id,
                  title: detail.task.title,
                  description: detail.task.description,
                  status: detail.task.status,
                  priority: detail.task.priority,
                  dueDate: detail.task.dueAt ? detail.task.dueAt.toISOString().slice(0, 10) : null,
                  estimateMinutes: detail.task.estimateMinutes,
                  version: detail.task.version,
                  subtasks: detail.subtasks.map((s) => ({
                    id: s.id,
                    title: s.title,
                    status: s.status,
                    version: s.version,
                  })),
                  blockedBy: detail.blockedBy.map((b) => ({ dependencyId: b.dependencyId, title: b.title })),
                  blocking: detail.blocking.map((b) => ({ dependencyId: b.dependencyId, title: b.title })),
                }}
                candidates={candidates}
              />
            ) : (
              <Empty title="Select a task" description="Pick a row to see its details and focus history." />
            )}
            {detail ? (
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-label font-medium">Focus history</p>
                  {activeSession ? (
                    <span className="text-data text-muted-foreground">Session live above</span>
                  ) : (
                    <FocusTaskButton task={{ id: detail.task.id, title: detail.task.title }} />
                  )}
                </div>
                {focusHistory.length ? (
                  <div className="divide-y divide-border/60">
                    {focusHistory.map((session) => (
                      <div key={session.id} className="py-1.5 first:pt-0">
                        <p className="readout text-data text-muted-foreground">
                          {session.state} · {Math.round(session.elapsedSeconds / 60)} min ·{" "}
                          {session.startedAt ? session.startedAt.toISOString().slice(0, 10) : "scheduled"}
                        </p>
                        {session.whatChanged ? <p className="text-label">Changed: {session.whatChanged}</p> : null}
                        {session.nextStep ? (
                          <p className="text-label text-muted-foreground">Next: {session.nextStep}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-data text-muted-foreground">No focus sessions against this task yet.</p>
                )}
              </div>
            ) : null}
            {detail ? <TaskEvidence items={provenance} taskId={detail.task.id} /> : null}
          </Panel>
        ) : scope === "today" ? (
          <aside className="flex min-w-0 flex-col gap-4">
            <section aria-labelledby="deadlines-heading" className="panel rounded-xl p-4">
              <div className="mb-3 flex items-center gap-2">
                <CalendarDays aria-hidden className="size-4 text-muted-foreground" />
                <h2 id="deadlines-heading" className="text-body-dense font-medium">
                  Upcoming deadlines
                </h2>
                <span className="readout text-data text-muted-foreground">{deadlineTotal}</span>
                <Link
                  href="/neuralflow/work?view=calendar"
                  className="ml-auto text-data text-muted-foreground hover:text-foreground"
                >
                  Calendar
                </Link>
              </div>
              {deadlineTotal === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-label text-muted-foreground">
                  No upcoming deadlines. Your schedule is clear.
                </p>
              ) : (
                <div className="divide-y divide-border/60">
                  {renderDeadlineGroup("Overdue", overdueDeadlines, "text-destructive")}
                  {renderDeadlineGroup("Today", dueTodayDeadlines, "text-primary")}
                  {renderDeadlineGroup("Coming up", upcomingDeadlines)}
                </div>
              )}
            </section>
            <section aria-labelledby="next-up-heading" className="panel rounded-xl p-4">
              <div className="mb-3 flex items-baseline gap-2">
                <h2 id="next-up-heading" className="text-body-dense font-medium">
                  Next up
                </h2>
                <span className="readout text-data text-muted-foreground">{nextUpCount}</span>
                <Link
                  href={listHref(BASE, raw, { view: "saved", show: undefined, task: undefined })}
                  className="ml-auto text-data text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                  All open
                </Link>
              </div>
              <CommitList
                rows={nextUp.map((r) => ({ ...r, dueAt: r.dueAt ? r.dueAt.toISOString() : null, href: hrefFor(r.id) }))}
                emptyState={
                  <p className="py-2 text-label text-muted-foreground">Every open task is committed to today.</p>
                }
              />
            </section>
            <section aria-labelledby="inbox-heading" className="panel rounded-xl p-4">
              <div className="mb-3 flex items-baseline gap-2">
                <h2 id="inbox-heading" className="text-body-dense font-medium">
                  Inbox
                </h2>
                <span className="readout text-data text-muted-foreground">{inboxCount}</span>
                {inboxCount > 0 ? (
                  <Link
                    href="/command-center/inbox"
                    className="ml-auto text-data text-muted-foreground transition-colors hover:text-foreground hover:underline"
                  >
                    Triage
                  </Link>
                ) : null}
              </div>
              <CommitList
                rows={[]}
                emptyState={
                  <p className="py-2 text-label text-muted-foreground">
                    {inboxCount === 0
                      ? "Nothing waiting. New captures land in Inbox until you commit them."
                      : `${inboxCount} captured, waiting for triage.`}
                  </p>
                }
              />
            </section>
          </aside>
        ) : null}
      </div>
    </Screen>
  );
}
