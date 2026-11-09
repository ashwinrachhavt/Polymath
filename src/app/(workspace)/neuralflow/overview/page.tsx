import { Suspense } from "react";
import Link from "next/link";
import { io } from "next/cache";
import { ArrowUpRight, CalendarDays, CheckCircle2, CircleDashed, Clock3 } from "lucide-react";
import { getAuthContext } from "@/lib/auth";
import { countWorkByStatusForPage, listTasksDueBetweenForPage, listWorkProjectSummariesForPage } from "../work/data";
import { Panel, Screen, StatStrip } from "@/components/workspace/ui";
import { getPreferences } from "@/domains/identity/preferences";
import { shiftDateKey, todayKeyInTimezone } from "@/lib/local-date";
import { listActivityEvents } from "@/domains/audit/queries";
import { presentActivityEvents } from "@/domains/audit/present";

export const metadata = { title: "Overview · Polymath" };

const statusRows = [
  { key: "inbox", label: "Inbox", color: "bg-amber-500" },
  { key: "backlog", label: "Backlog", color: "bg-muted-foreground/50" },
  { key: "ready", label: "To do", color: "bg-sky-500" },
  { key: "in_progress", label: "In progress", color: "bg-indigo-400" },
  { key: "waiting", label: "Waiting", color: "bg-violet-400" },
  { key: "done", label: "Done", color: "bg-emerald-500" },
  { key: "cancelled", label: "Cancelled", color: "bg-muted-foreground/30" },
] as const;

function shortDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

async function WorkOverviewSurface() {
  await io();
  const auth = await getAuthContext();
  const { timezone } = await getPreferences(auth);
  const today = todayKeyInTimezone(timezone);
  const [counts, projects, dueTasks, activityPage] = await Promise.all([
    countWorkByStatusForPage(auth),
    listWorkProjectSummariesForPage(auth),
    listTasksDueBetweenForPage(auth, today, shiftDateKey(today, 14)),
    listActivityEvents(auth, { limit: 8, filters: { includeTechnical: false } }),
  ]);
  const activities = await presentActivityEvents(auth, activityPage.rows);
  const total = statusRows.reduce((sum, row) => sum + counts[row.key], 0);
  const open = total - counts.done - counts.cancelled;
  const activeProjects = projects.filter((project) => project.phase === "active").length;
  const statusMax = Math.max(1, ...statusRows.map((row) => counts[row.key]));
  const soon = dueTasks.filter((task) => task.status !== "done" && task.status !== "cancelled").slice(0, 7);

  return (
    <Screen
      title="Workspace overview"
      description="A clear view of project health and the work moving through your workspace."
      actions={
        <Link
          href="/neuralflow/work?view=board"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition duration-150 ease-out hover:opacity-90 active:scale-[.98]"
        >
          Open board <ArrowUpRight aria-hidden className="size-4" />
        </Link>
      }
    >
      <StatStrip
        className="grid-cols-2 sm:grid-cols-4"
        items={[
          { label: "Active projects", value: activeProjects, hint: `${projects.length} in your workspace` },
          { label: "Open tasks", value: open, hint: "Across all projects" },
          { label: "Completed", value: counts.done, hint: "Tasks finished" },
          { label: "Inbox", value: counts.inbox, hint: "Waiting to be clarified" },
        ]}
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(19rem,1fr)]">
        <Panel
          title="Portfolio"
          description={`${projects.length} projects · progress from completed tasks`}
          actions={
            <Link
              href="/neuralflow/work?view=saved"
              className="inline-flex items-center gap-1 text-label text-muted-foreground transition-colors hover:text-foreground"
            >
              All tasks <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          }
        >
          {projects.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-body-dense text-muted-foreground">
              Projects will appear here when you add them to your workspace.
            </p>
          ) : (
            <div className="-mx-4 divide-y divide-border border-y border-border sm:mx-0 sm:rounded-lg sm:border">
              <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(7rem,1fr)_8rem_3rem] gap-4 px-4 py-2 text-xs text-muted-foreground sm:grid">
                <span>Project</span>
                <span>Status</span>
                <span>Progress</span>
                <span className="text-right">Open</span>
              </div>
              {projects.map((project) => {
                const progress = project.taskCount ? Math.round((project.completedCount / project.taskCount) * 100) : 0;
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="group grid gap-2 px-4 py-3 transition-colors duration-150 hover:bg-muted/40 sm:grid-cols-[minmax(0,1.5fr)_minmax(7rem,1fr)_8rem_3rem] sm:items-center sm:gap-4"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium transition-colors group-hover:text-primary">
                        {project.name}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {project.taskCount} tasks{project.targetDate ? ` · due ${project.targetDate}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className={`size-2 rounded-full ${project.phase === "completed" ? "bg-emerald-500" : project.phase === "active" ? "bg-primary" : "bg-muted-foreground/60"}`}
                      />
                      <span className="capitalize">{project.phase.replaceAll("_", " ")}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className={`block h-full rounded-full transition-[width] duration-300 ease-out ${project.phase === "completed" ? "bg-emerald-500" : "bg-primary"}`}
                          style={{ width: `${progress}%` }}
                        />
                      </span>
                      <span className="readout w-8 text-right text-xs text-muted-foreground">{progress}%</span>
                    </span>
                    <span className="readout text-right text-xs text-muted-foreground sm:text-sm">
                      {project.openCount}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Tasks by status" description={`${total} tasks across your workspace`}>
          <div className="mb-4 flex h-2 overflow-hidden rounded-full bg-muted" aria-label="Task distribution by status">
            {statusRows.map((row) => (
              <span
                key={row.key}
                className={row.color}
                style={{ width: `${total ? (counts[row.key] / total) * 100 : 0}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-3">
            {statusRows.map((row) => {
              const count = counts[row.key];
              return (
                <li key={row.key} className="flex items-center gap-3 text-sm">
                  <span className={`size-2.5 rounded-full ${row.color}`} aria-hidden />
                  <span className="min-w-0 flex-1">{row.label}</span>
                  <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted sm:w-24">
                    <span
                      className={`block h-full rounded-full ${row.color}`}
                      style={{ width: `${(count / statusMax) * 100}%` }}
                    />
                  </span>
                  <span className="readout w-7 text-right text-xs text-muted-foreground">{count}</span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel
          title="Upcoming deadlines"
          description="Open work due in the next two weeks."
          actions={<CalendarDays aria-hidden className="size-4 text-muted-foreground" />}
        >
          {soon.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No upcoming deadlines. Your schedule is clear.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {soon.map((task) => (
                <li key={task.id}>
                  <Link
                    href={`/neuralflow/work?view=saved&task=${task.id}`}
                    className="group flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <CircleDashed aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium transition-colors group-hover:text-primary">
                        {task.title}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {task.projectName ?? "Unassigned project"}
                      </span>
                    </span>
                    <span className="readout shrink-0 text-xs text-muted-foreground">{shortDate(task.dueAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent activity"
          description="The latest changes in your workspace."
          actions={
            <Link href="/activity" className="text-label text-muted-foreground transition-colors hover:text-foreground">
              View all
            </Link>
          }
        >
          {activities.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              New project and task activity will show here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {activities.slice(0, 6).map((item) => (
                <li key={item.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    {item.technical.action.startsWith("task.") ? (
                      <CheckCircle2 aria-hidden className="size-3.5" />
                    ) : (
                      <Clock3 aria-hidden className="size-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-snug">{item.sentence}</span>
                    {item.title ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.title}</span>
                    ) : null}
                  </span>
                  <time className="shrink-0 text-xs text-muted-foreground">{item.timeAgo}</time>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Screen>
  );
}

export default function WorkOverviewPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-[13px] text-muted-foreground">
          Loading overview…
        </p>
      }
    >
      <WorkOverviewSurface />
    </Suspense>
  );
}
