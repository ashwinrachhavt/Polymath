import Link from "next/link";
import { io } from "next/cache";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { WORK_OPEN_STATUSES, WORK_PRIORITIES, countWorkByStatus, type WorkRow } from "@/domains/work/queries";
import { getTaskDetailForPage, getActiveFocusSessionForPage, getLastTaskHandoffForPage, listFocusHistoryForPage, listWorkPageForPage, listWorkRowsForPage } from "./data";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { getTaskProvenance } from "@/domains/knowledge/queries";
import { TaskCard } from "./task-controls";
import { FocusTaskButton, ActiveSessionControls } from "./focus-controls";
import { TaskEvidence } from "./task-evidence";
import { CommitList, WorkList } from "./work-list";
import { DayStrip } from "./day-strip";
import { SeedSuggestions } from "./seed-suggestions";
import { listSeedsForDay } from "@/domains/work/seeds";
import { todayKeyInTimezone } from "@/lib/local-date";
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

export function scopeOf(show: string | undefined): Scope {
  return show === "today" || show === "done" ? show : "open";
}

const BASE = "/neuralflow/work";
const UUID = /^[0-9a-f-]{36}$/i;

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
  const statusChoices = scope === "today" ? (["ready", "in_progress"] as const) : scope === "open" ? WORK_OPEN_STATUSES : ([] as const);
  const list = parseListParams(raw, { filters: { priority: WORK_PRIORITIES, status: statusChoices } });
  const filtered = Boolean(list.q || list.filters.priority || list.filters.status);
  const validSelection = selectedTask && UUID.test(selectedTask) ? selectedTask : undefined;

  // Tomorrow's suggestions belong to today: the shutdown ritual wrote them for
  // this local day, and "today" compares in the owner's saved timezone.
  const { timezone } = await getPreferences(auth);
  const [found, openRows, counts, activeSession, seeds] = await Promise.all([
    listWorkPageForPage(auth, scope, {
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
      query: list.q || undefined,
      priority: list.filters.priority as (typeof WORK_PRIORITIES)[number] | undefined,
      status: list.filters.status as (typeof WORK_OPEN_STATUSES)[number] | undefined,
    }),
    listWorkRowsForPage(auth, "open"),
    countWorkByStatus(auth),
    getActiveFocusSessionForPage(auth),
    listSeedsForDay(auth, todayKeyInTimezone(timezone)).catch(() => []),
  ]);
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const rows = found.rows;

  // The inspector never sits empty: with no explicit selection it shows the
  // first committed task, which is also the row the owner is most likely to
  // start. A filtered or empty list falls back to no detail rather than a
  // task the list is not showing.
  const detailId = validSelection ?? (scope === "today" ? rows[0]?.id : undefined);
  const [detail, focusHistory] = await Promise.all([
    detailId ? getTaskDetailForPage(auth, detailId) : null,
    detailId ? listFocusHistoryForPage(auth, 5, detailId) : [],
  ]);
  const [lastHandoff, provenance] = await Promise.all([
    activeSession?.taskId ? getLastTaskHandoffForPage(auth, activeSession.taskId) : null,
    detail ? getTaskProvenance(auth, detail.task.id) : [],
  ]);
  const candidates = detail ? openRows.filter((r) => r.id !== detail.task.id).map((r) => ({ id: r.id, title: r.title })) : [];

  // The path into today: open work that is not already a commitment, then
  // whatever was captured and never triaged. Both are counts of real rows, and
  // both disappear once there is nothing left to commit.
  const committedIds = new Set(openRows.filter((r) => r.status === "ready" || r.status === "in_progress").map((r) => r.id));
  // A suggested task is offered once, by the suggestion: the same row in Next
  // up would be two controls for one decision, and the owner would see the
  // task they are deciding about twice before deciding.
  const suggestedIds = new Set(seeds.map((seed) => seed.taskId));
  const nextUp = openRows.filter((r) => !committedIds.has(r.id) && !suggestedIds.has(r.id)).slice(0, 5);
  const inboxCount = counts.inbox;

  const hrefFor = (id: string) => listHref(BASE, raw, { view: "saved", task: id });
  const scopeLabel = scope === "today" ? "committed" : scope === "open" ? "open" : "finished";
  // "Inbox" on Today is the triage count, not the rows: captured work is
  // triaged on Inbox, and this screen's job is to say how much is waiting.
  const nextUpCount = nextUp.length;

  return (
    <Screen
      title="Work"
      actions={
        <Link href="/neuralflow/work?view=today" className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
          New session
        </Link>
      }
    >
      {scope === "today" ? <DayStrip auth={auth} /> : null}

      {activeSession ? (
        <Panel
          className="border-app-accent/40"
          title={activeSession.subject || "Focus session"}
          description={activeSession.state === "running" ? "A focus session is running." : "A focus session is paused."}
        >
          {lastHandoff ? (
            <p className="mb-3 border-b border-border pb-3 text-[13px] text-muted-foreground">
              Last time: {lastHandoff.nextStep}
            </p>
          ) : null}
          <ActiveSessionControls
            key={`${activeSession.id}:${activeSession.version}`}
            session={{
              id: activeSession.id,
              subject: activeSession.subject,
              state: activeSession.state as "running" | "paused",
              plannedMinutes: activeSession.plannedMinutes,
              elapsedSeconds: activeSession.elapsedSeconds,
              version: activeSession.version,
              hasTask: !!activeSession.taskId,
            }}
          />
        </Panel>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2">
            <h2 className="text-[15px] font-medium">{scope === "today" ? "Today" : scope === "done" ? "Finished" : "Open"}</h2>
            <span className="readout text-[12px] text-muted-foreground">
              {found.total} {scopeLabel}
            </span>
            <nav aria-label="Saved task filter" className="ml-auto flex gap-3 text-[12px]">
              <Link
                className={scope === "today" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                href={listHref(BASE, raw, { view: "saved", show: "today", status: undefined, page: undefined, task: undefined })}
                aria-current={scope === "today" ? "page" : undefined}
              >
                Today
              </Link>
              <Link
                className={scope === "open" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                href={listHref(BASE, raw, { view: "saved", show: undefined, status: undefined, page: undefined, task: undefined })}
                aria-current={scope === "open" ? "page" : undefined}
              >
                Open
              </Link>
              <Link
                className={scope === "done" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                href={listHref(BASE, raw, { view: "saved", show: "done", status: undefined, page: undefined, task: undefined })}
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
                  ? [{ key: "status", label: "State", allLabel: "Any state", options: statusChoices.map((v) => ({ value: v, label: statusLabel[v] })) }]
                  : []),
                { key: "priority", label: "Priority", allLabel: "Any priority", options: WORK_PRIORITIES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
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
                clearHref={listHref(BASE, raw, { q: undefined, status: undefined, priority: undefined, page: undefined })}
                emptyTitle={scope === "today" ? "Nothing committed for today" : scope === "done" ? "No finished tasks yet" : "No open tasks"}
                emptyDescription={
                  scope === "today"
                    ? "Add a task above and it lands here. Or commit one from Inbox below."
                    : undefined
                }
              />
            }
            items={rows.map((row) => ({
              row: {
                id: row.id,
                title: row.title,
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

          {scope === "today" && !filtered ? (
            <div className="mt-6 flex flex-col gap-6">
              <section aria-labelledby="next-up-heading">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <h2 id="next-up-heading" className="text-[13px] font-medium">Next up</h2>
                  <span className="readout text-[11px] text-muted-foreground">{nextUpCount}</span>
                  <Link href={listHref(BASE, raw, { view: "saved", show: undefined, task: undefined })} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                    All open
                  </Link>
                </div>
                <CommitList
                  rows={nextUp.map((r) => ({ ...r, dueAt: r.dueAt ? r.dueAt.toISOString() : null, href: hrefFor(r.id) }))}
                  emptyState={<p className="py-2 text-[12px] text-muted-foreground">Every open task is committed to today.</p>}
                />
              </section>

              <section aria-labelledby="inbox-heading">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <h2 id="inbox-heading" className="text-[13px] font-medium">Inbox</h2>
                  <span className="readout text-[11px] text-muted-foreground">{inboxCount}</span>
                  {inboxCount > 0 ? (
                    <Link href="/command-center/inbox" className="ml-auto text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                      Triage
                    </Link>
                  ) : null}
                </div>
                <CommitList
                  rows={[]}
                  emptyState={
                    <p className="py-2 text-[12px] text-muted-foreground">
                      {inboxCount === 0
                        ? "Nothing waiting. New captures land in Inbox until you commit them."
                        : `${inboxCount} captured, waiting for triage.`}
                    </p>
                  }
                />
              </section>

              <nav aria-label="Related tools" className="flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
                <Link className="py-1 hover:text-foreground hover:underline" href="/command-center/inbox">Brain dump</Link>
                <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/reports">Weekly review</Link>
                <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/rewards">Stone collection</Link>
              </nav>
            </div>
          ) : null}
        </div>

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
                subtasks: detail.subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status, version: s.version })),
                blockedBy: detail.blockedBy.map((b) => ({ dependencyId: b.dependencyId, title: b.title })),
                blocking: detail.blocking.map((b) => ({ dependencyId: b.dependencyId, title: b.title })),
              }}
              candidates={candidates}
            />
          ) : (
            <Empty
              title={scope === "today" ? "No task committed yet" : "Select a task"}
              description={scope === "today" ? "Anything you add above opens here, with its history and a way to start a session." : "Pick a row to see its details and focus history."}
            />
          )}
          {detail ? (
            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[12px] font-medium">Focus history</p>
                {activeSession ? (
                  <span className="text-[11px] text-muted-foreground">Session live above</span>
                ) : (
                  <FocusTaskButton task={{ id: detail.task.id, title: detail.task.title }} />
                )}
              </div>
              {focusHistory.length ? (
                <div className="divide-y divide-border/60">
                  {focusHistory.map((session) => (
                    <div key={session.id} className="py-1.5 first:pt-0">
                      <p className="readout text-[11px] text-muted-foreground">
                        {session.state} · {Math.round(session.elapsedSeconds / 60)} min · {session.startedAt ? session.startedAt.toISOString().slice(0, 10) : "scheduled"}
                      </p>
                      {session.whatChanged ? <p className="text-[12px]">Changed: {session.whatChanged}</p> : null}
                      {session.nextStep ? <p className="text-[12px] text-muted-foreground">Next: {session.nextStep}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">No focus sessions against this task yet.</p>
              )}
            </div>
          ) : null}
          {detail ? <TaskEvidence items={provenance} /> : null}
        </Panel>
      </div>
    </Screen>
  );
}
