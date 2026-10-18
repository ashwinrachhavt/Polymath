import Link from "next/link";
import { connection } from "next/server";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { getTaskDetail, listWorkRows, type WorkRow } from "@/domains/work/queries";
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

export async function NeonTasks({ show, selectedTask }: { show?: string; selectedTask?: string }) {
  // Per-user data: render at request time, never prerender.
  await connection();
  const auth = await getAuthContext();
  const scope = scopeOf(show);
  const rows = await listWorkRows(auth, scope);
  const detail = selectedTask && /^[0-9a-f-]{36}$/i.test(selectedTask) ? await getTaskDetail(auth, selectedTask) : null;
  const openRows = scope === "open" ? rows : detail ? await listWorkRows(auth, "open") : [];
  const candidates = detail ? openRows.filter((r) => r.id !== detail.task.id).map((r) => ({ id: r.id, title: r.title })) : [];
  const base = `/neuralflow/work?view=saved`;
  const showParam = scope === "open" ? "" : `&show=${scope}`;
  const tab = (value: Scope, label: string) => (
    <Link
      key={value}
      className={`rounded px-2 py-1 ${scope === value ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
      href={value === "open" ? base : `${base}&show=${value}`}
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
          {rows.length === 0 ? (
            <Empty
              title={scope === "today" ? "Nothing committed for today" : scope === "done" ? "No finished tasks yet" : "No open tasks"}
              description={scope === "today" ? "Open a task from the list and set it to Ready to put it here." : "Add a task above."}
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row, i) => (
                <li key={row.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link href={`${base}${showParam}&task=${row.id}`} className="text-[13px] font-medium hover:underline" aria-current={detail?.task.id === row.id ? "true" : undefined}>
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
                    showMove={scope !== "done"}
                    up={i > 0 ? { after: rows[i - 2]?.id, before: rows[i - 1].id } : null}
                    down={i < rows.length - 1 ? { after: rows[i + 1].id, before: rows[i + 2]?.id } : null}
                  />
                </li>
              ))}
            </ul>
          )}
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
        </Panel>
      </div>
    </Screen>
  );
}
