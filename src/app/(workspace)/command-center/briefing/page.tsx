import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { type BriefingTask, getBriefing } from "@/domains/work/briefing";
import { getAuthContext } from "@/lib/auth";
import { OutcomeButton } from "./briefing-client";

export const metadata = { title: "Briefing · Axiom" };

/*
 * The durable Briefing (ASH-137 A01): three outcomes, today's queue and the
 * waiting list all read the canonical tasks table. Accepting an outcome is a
 * version-checked tag on the task - nothing here schedules, calls a model,
 * or touches a connector. The browser-preview briefing with its local
 * agenda, stones and activity panels stays at /apps/command-center/briefing.
 */

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
        {mode === "replace" ? <Status>Accepted outcome</Status> : null}
        <OutcomeButton taskId={task.id} version={task.version} tags={task.tags} outcomeTag={outcomeTag} mode={mode} />
      </div>
    </div>
  );
}

async function Briefing() {
  const auth = await getAuthContext();
  const briefing = await getBriefing(auth);
  const outcomeTag = `Outcome:${briefing.today}`;

  return (
    <Screen
      title="Briefing"
      description={`Capture, clarify, commit, focus, review, learn. Here is where ${briefing.today} stands, read from the canonical task record. Nothing on this page calls a model or a connector.`}
      actions={
        <>
          <Button variant="outline" size="sm" asChild><Link href="/command-center/inbox">Clarify inbox</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/neuralflow/work">Open Work</Link></Button>
        </>
      }
    >
      <Panel
        title="Three outcomes"
        description="Deterministic suggestions ordered by due date and priority. Accepting tags the canonical task for this day; it does not schedule or start work."
      >
        <div className="divide-y divide-border">
          {briefing.outcomes.map((task) => <TaskRow key={task.id} task={task} outcomeTag={outcomeTag} mode="replace" />)}
          {briefing.suggested.map((task) => <TaskRow key={task.id} task={task} outcomeTag={outcomeTag} mode="accept" />)}
        </div>
        {!briefing.outcomes.length && !briefing.suggested.length ? (
          <Empty title="No open outcome candidates" description="Create work in NeuralFlow, then accept it as an outcome." />
        ) : null}
      </Panel>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Panel title="Today and overdue" description="Open work with a due date on or before today.">
          <div className="divide-y divide-border">
            {briefing.dueTodayOrOverdue.map((task) => (
              <div key={task.id} className="py-3 first:pt-0">
                <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
                  {task.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">due {task.dueAt?.toISOString().slice(0, 10)} · {task.priority} priority</p>
              </div>
            ))}
          </div>
          {!briefing.dueTodayOrOverdue.length ? <Empty title="Nothing due" description="No open work is due today or earlier." /> : null}
        </Panel>
        <Panel title="Waiting commitments" description="Open work currently waiting on someone or something.">
          <div className="divide-y divide-border">
            {briefing.waiting.map((task) => (
              <div key={task.id} className="py-3 first:pt-0">
                <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
                  {task.title}
                </Link>
              </div>
            ))}
          </div>
          {!briefing.waiting.length ? <Empty title="Nothing waiting" description="No commitments are parked." /> : null}
        </Panel>
      </div>
    </Screen>
  );
}

export default function BriefingPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Preparing the briefing…</p>}>
      <Briefing />
    </Suspense>
  );
}
