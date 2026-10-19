import Link from "next/link";
import { connection } from "next/server";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { listFocusHistory } from "@/domains/focus/queries";
import { getTaskDetail, listWorkPage, listWorkRows, WORK_OPEN_STATUSES, WORK_PRIORITIES, type WorkRow } from "@/domains/work/queries";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { QuickAdd, RowActions, TaskCard } from "./task-controls";

/*
 * The Work list on Neon. Server component: reads through the work domain's
 * queries, never the preview store. Today is the owner's explicit commitment
 * (Ready or In progress); Open is everything unfinished; Done is finished work.
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
  await connection();
  const auth = await getAuthContext();
  const scope = scopeOf(show);
  const statusChoices = scope === "today" ? (["ready", "in_progress"] as const) : scope === "open" ? WORK_OPEN_STATUSES : ([] as const);
  const list = parseListParams(raw, { filters: { priority: WORK_PRIORITIES, status: statusChoices } });
  const filtered = Boolean(list.q || list.filters.priority || list.filters.status);
  const found = await listWorkPage(auth, scope, {
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
    query: list.q || undefined,
    priority: list.filters.priority as (typeof WORK_PRIORITIES)[number] | undefined,
    status: list.filters.status as (typeof WORK_OPEN_STATUSES)[number] | undefined,
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const rows = found.rows;
  const win = found.window;
  // Reordering is a rank between two neighbours; with rows hidden by a filter
  // the neighbours are not adjacent in the real order, so moves wait for a clear list.
  const canMove = scope !== "done" && !filtered;
  const detail = selectedTask && /^[0-9a-f-]{36}$/i.test(selectedTask) ? await getTaskDetail(auth, selectedTask) : null;
  const focusHistory = detail ? await listFocusHistory(auth, 10, detail.task.id) : [];
  const openRows = detail ? await listWorkRows(auth, "open") : [];
  const candidates = detail ? openRows.filter((r) => r.id !== detail.task.id).map((r) => ({ id: r.id, title: r.title })) : [];
  const tab = (value: Scope, label: string) => (
    <Link
      key={value}
      className={`rounded px-2 py-1 ${scope === value ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
      href={listHref(BASE, raw, { view: "saved", show: value === "open" ? undefined : value, status: undefined, page: undefined, task: undefined })}
    >
      {label}
    </Link>
  );

  return (
    <Screen
      title="Work"
      description="Saved tasks in rank order. Today shows only Ready and In progress work; move a task to Ready when you choose to work on it."
    >
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel
          title={scope === "today" ? "Today" : scope === "done" ? "Finished" : "Open tasks"}
          actions={
            <nav aria-label="Saved task filter" className="flex gap-1 text-xs">
              {tab("today", "Today")}
              {tab("open", "Open")}
              {tab("done", "Finished")}
            </nav>
          }
        >
          {scope !== "done" && <div className="mb-4"><QuickAdd /></div>}
          <div className="mb-4">
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
          {rows.length === 0 ? (
            <NoResults
              filtered={filtered}
              clearHref={listHref(BASE, raw, { q: undefined, status: undefined, priority: undefined, page: undefined })}
              emptyTitle={scope === "today" ? "Nothing committed for today" : scope === "done" ? "No finished tasks yet" : "No open tasks"}
              emptyDescription={scope === "today" ? "Open a task from the list and set it to Ready to put it here." : "Add a task above."}
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row, i) => (
                <li key={row.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link href={listHref(BASE, raw, { view: "saved", task: row.id })} className="text-[13px] font-medium hover:underline" aria-current={detail?.task.id === row.id ? "true" : undefined}>
                      {row.title}
                    </Link>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Status>{statusLabel[row.status]}</Status>
                      {row.priority !== "none" && <Status>{row.priority}</Status>}
                      {row.dueAt && <span className="readout text-xs text-muted-foreground">Due {row.dueAt.toISOString().slice(0, 10)}</span>}
                      {row.subtaskCount > 0 && <span className="text-xs text-muted-foreground">{row.subtasksDone}/{row.subtaskCount} subtasks</span>}
                      {row.blockedBy > 0 && <Status>Blocked by {row.blockedBy}</Status>}
                    </div>
                  </div>
                  <RowActions
                    taskId={row.id}
                    title={row.title}
                    version={row.version}
                    showMove={canMove}
                    up={win[i + found.lead - 1] ? { after: win[i + found.lead - 2]?.id, before: win[i + found.lead - 1]!.id } : null}
                    down={win[i + found.lead + 1] ? { after: win[i + found.lead + 1]!.id, before: win[i + found.lead + 2]?.id } : null}
                  />
                </li>
              ))}
            </ul>
          )}
          <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} />
        </Panel>

        <Panel title={detail ? "Task" : "Task details"}>
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
            <Empty title="Select a task" description="Open a task to edit it, split it into subtasks, or record what blocks it." />
          )}
          {detail ? (
            <div className="mt-4 border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium">Focus history</p>
                <Link
                  href={`/neuralflow/focus?task=${detail.task.id}`}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  Start a focus session
                </Link>
              </div>
              {focusHistory.length ? (
                <div className="divide-y divide-border">
                  {focusHistory.map((session) => (
                    <div key={session.id} className="py-2 first:pt-0">
                      <p className="text-xs text-muted-foreground">
                        {session.state} · {Math.round(session.elapsedSeconds / 60)} min · {session.startedAt.toISOString().slice(0, 10)}
                      </p>
                      {session.whatChanged ? <p className="text-[13px]">Changed: {session.whatChanged}</p> : null}
                      {session.nextStep ? <p className="text-[13px] text-muted-foreground">Next: {session.nextStep}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No focus sessions against this task yet.</p>
              )}
            </div>
          ) : null}
        </Panel>
      </div>
    </Screen>
  );
}
