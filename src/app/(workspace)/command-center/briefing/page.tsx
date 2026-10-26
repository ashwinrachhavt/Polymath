import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { type BriefingTask } from "@/domains/work/briefing";
import { getBriefingForPage } from "./data";
import { getAuthContext } from "@/lib/auth";
import { AgentPanels } from "./agent-panels";
import { SpendingPanel } from "./spending-panel";
import { OutcomeButton, StartFocusButton } from "./briefing-client";
import { CaptureStrip } from "./theatre/capture-strip";
import { getTheatreDay } from "./theatre/theatre-data";
import { TheatreTimeline } from "./theatre/timeline";

export const metadata = { title: "Briefing · Polymath" };

/*
 * The durable Briefing (ASH-137 A01), now wearing the Day Theatre (ASH-308):
 * the day reads as one timeline - focus sessions, calendar events, and what
 * the inbox received - with the decisions strip, waiting list and due panel
 * unchanged below it. Accepting an outcome is still a version-checked tag on
 * the task; nothing here schedules, calls a model, or touches a connector.
 * The theatre never mutates the inbox: dragging a capture onto an hour plans
 * a session that points at the capture. The browser-preview briefing with
 * its local agenda, stones and activity panels stays at
 * /apps/command-center/briefing.
 */

function BriefingTabs({ active }: { active: "briefing" | "spending" }) {
  const tabs = [
    { id: "briefing" as const, label: "Briefing", href: "/command-center/briefing" },
    { id: "spending" as const, label: "Spending", href: "/command-center/briefing?tab=spending" },
  ];
  return (
    <nav aria-label="Briefing views" className="-mx-1 flex gap-1 px-1">
      {tabs.map(({ id, label, href }) => (
        <Link
          key={id}
          href={href}
          aria-current={active === id ? "page" : undefined}
          className={`inline-flex min-h-9 items-center rounded-md px-3 text-[13px] font-medium transition-colors ${active === id ? "bg-app-accent text-app-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function TaskRow({ task, outcomeTag, mode }: { task: BriefingTask; outcomeTag: string; mode: "accept" | "replace" }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
      <div>
        <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
          {task.title}
        </Link>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {task.status.replaceAll("_", " ")}
          {task.dueAt ? ` · due ${task.dueAt.toISOString().slice(0, 10)}` : " · no deadline"} · {task.priority} priority
        </p>
      </div>
      <div className="flex items-center gap-2">
        {mode === "replace" ? <Status>Accepted outcome</Status> : <Status>Suggested</Status>}
        <StartFocusButton task={{ id: task.id, title: task.title }} />
        <OutcomeButton taskId={task.id} version={task.version} tags={task.tags} outcomeTag={outcomeTag} mode={mode} />
      </div>
    </div>
  );
}

async function Briefing() {
  await io();
  const auth = await getAuthContext();
  const [briefing, theatre] = await Promise.all([getBriefingForPage(auth), getTheatreDay(auth)]);
  const outcomeTag = `Outcome:${briefing.today}`;

  return (
    <Screen
      title="Briefing"
      actions={
        <>
          <Button variant="outline" size="sm" asChild><Link href={`/command-center/briefing/day/${briefing.today}`}>This day</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/command-center/inbox">Clarify inbox</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/command-center/briefing/shutdown">Shut down</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/neuralflow/work">Open Work</Link></Button>
        </>
      }
    >
      <BriefingTabs active="briefing" />

      <Panel
        title="The day"
        description="Drag a capture onto an hour to plan it; the theatre refreshes itself while this tab is visible."
      >
        <div className="space-y-4">
          {theatre.errors.captures ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-[12px]" role="alert">
              Captures unavailable - {theatre.errors.captures}
            </div>
          ) : (
            <CaptureStrip captures={theatre.captures.map((capture) => ({ ...capture, createdAt: capture.createdAt.toISOString() }))} />
          )}
          <TheatreTimeline
            dayStart={theatre.dayStart}
            renderedAt={theatre.renderedAt}
            sessions={theatre.sessions}
            events={theatre.events}
            sessionError={theatre.errors.sessions}
            eventError={theatre.errors.events}
          />
        </div>
      </Panel>

      <Panel
        title="Three outcomes"
        description="Accepting tags the canonical task for this day; it does not schedule or start work."
      >
        <div className="divide-y divide-border">
          {briefing.outcomes.map((task) => <TaskRow key={task.id} task={task} outcomeTag={outcomeTag} mode="replace" />)}
          {briefing.suggested.map((task) => <TaskRow key={task.id} task={task} outcomeTag={outcomeTag} mode="accept" />)}
        </div>
        {!briefing.outcomes.length && !briefing.suggested.length ? (
          <Empty
            title="No open outcome candidates"
            action={<Button size="sm" asChild><Link href="/neuralflow/work">Create a commitment</Link></Button>}
          />
        ) : null}
      </Panel>

      <Suspense fallback={<p role="status" className="text-[13px] text-muted-foreground">Checking the agents…</p>}>
        <AgentPanels />
      </Suspense>

      {briefing.dueTodayOrOverdue.length || briefing.waiting.length ? (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {briefing.dueTodayOrOverdue.length ? (
            <Panel title="Today and overdue">
              <div className="divide-y divide-border">
                {briefing.dueTodayOrOverdue.map((task) => (
                  <div key={task.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                    <div>
                      <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
                        {task.title}
                      </Link>
                      <p className="mt-0.5 text-xs text-muted-foreground">due {task.dueAt?.toISOString().slice(0, 10)} · {task.priority} priority</p>
                    </div>
                    <StartFocusButton task={{ id: task.id, title: task.title }} />
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
          {briefing.waiting.length ? (
            <Panel title="Waiting commitments">
              <div className="divide-y divide-border">
                {briefing.waiting.map((task) => (
                  <div key={task.id} className="py-3 first:pt-0">
                    <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
                      {task.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      waiting{task.dueAt ? ` · due ${task.dueAt.toISOString().slice(0, 10)}` : ""} · {task.priority} priority
                    </p>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </Screen>
  );
}

async function Spending() {
  await io();
  return (
    <Screen title="Briefing">
      <BriefingTabs active="spending" />
      <SpendingPanel />
    </Screen>
  );
}

/*
 * `searchParams` is read INSIDE the Suspense boundary, not before it. Reading
 * it in the page body made the route block on URL data before the shell could
 * stream, which under `cacheComponents` broke navigation: the fallback stuck
 * and no heading ever rendered. Splitting the tab read into its own component
 * keeps the read where it belongs — 56c33ea fixed the same shape elsewhere.
 */
export default async function BriefingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Preparing the briefing…</p>}>
      <BriefingTab searchParams={searchParams} />
    </Suspense>
  );
}

async function BriefingTab({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  return typeof raw.tab === "string" && raw.tab === "spending" ? <Spending /> : <Briefing />;
}
