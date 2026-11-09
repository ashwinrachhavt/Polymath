import { Suspense } from "react";
import Link from "next/link";
import { io } from "next/cache";
import { ArrowUpRight } from "lucide-react";
import { getAuthContext } from "@/lib/auth";
import { countWorkByStatus } from "@/domains/work/queries";
import { listWorkProjectSummariesForPage } from "../work/data";
import { Panel, Screen, StatStrip, Status } from "@/components/workspace/ui";

export const metadata = { title: "Overview · Polymath" };

const statusRows = [
  { key: "inbox", label: "Inbox", color: "bg-amber-500" },
  { key: "backlog", label: "Backlog", color: "bg-muted-foreground/50" },
  { key: "ready", label: "To do", color: "bg-sky-500" },
  { key: "in_progress", label: "In progress", color: "bg-indigo-400" },
  { key: "waiting", label: "Waiting", color: "bg-violet-400" },
  { key: "done", label: "Done", color: "bg-emerald-500" },
] as const;

async function WorkOverviewSurface() {
  await io();
  const auth = await getAuthContext();
  const [counts, projects] = await Promise.all([countWorkByStatus(auth), listWorkProjectSummariesForPage(auth)]);
  const total = statusRows.reduce((sum, row) => sum + counts[row.key], 0) + counts.cancelled;
  const open = total - counts.done - counts.cancelled;
  const activeProjects = projects.filter((project) => project.phase === "active").length;

  return (
    <Screen
      title="Overview"
      description="The health of your projects and the work moving through them."
      actions={
        <Link
          href="/neuralflow/work?view=board"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
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

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(18rem,1fr)]">
        <Panel
          title="Projects"
          description="Progress from the tasks attached to each project."
          actions={
            <Link
              href="/neuralflow/work?view=board"
              className="inline-flex items-center gap-1 text-label text-muted-foreground hover:text-foreground"
            >
              View tasks <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          }
        >
          {projects.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-body-dense text-muted-foreground">
              Projects will appear here when you add them to your workspace.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {projects.map((project) => {
                const progress = project.taskCount ? Math.round((project.completedCount / project.taskCount) * 100) : 0;
                return (
                  <article
                    key={project.id}
                    className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1.2fr)_minmax(8rem,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">{project.name}</h3>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {project.openCount} open · {project.taskCount} tasks
                        {project.targetDate ? ` · due ${project.targetDate}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${project.phase === "completed" ? "bg-emerald-500" : "bg-primary"}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="readout w-9 text-right text-xs text-muted-foreground">{progress}%</span>
                    </div>
                    <Status>{project.phase.replaceAll("_", " ")}</Status>
                  </article>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Tasks by status" description={`${total} tasks across your workspace.`}>
          <div className="mb-5 flex h-2 overflow-hidden rounded-full bg-muted" aria-label="Task distribution by status">
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
              const percent = total ? Math.round((count / total) * 100) : 0;
              return (
                <li key={row.key} className="flex items-center gap-3 text-sm">
                  <span className={`size-2.5 rounded-full ${row.color}`} aria-hidden />
                  <span className="min-w-0 flex-1">{row.label}</span>
                  <span className="readout text-xs text-muted-foreground">{count}</span>
                  <span className="readout w-9 text-right text-xs text-muted-foreground">{percent}%</span>
                </li>
              );
            })}
          </ul>
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
