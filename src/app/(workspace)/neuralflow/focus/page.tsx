import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getActiveFocusSession, listFocusHistory } from "@/domains/focus/queries";
import { getTaskDetail } from "@/domains/work/queries";
import { getAuthContext } from "@/lib/auth";
import { FeatureLinks } from "../work/work-today";
import { ActiveSessionControls, StartSessionForm } from "./focus-controls";

export const metadata = { title: "Focus · Polymath" };

/*
 * Durable focus (ASH-137 A09): the session lives in Postgres, not the
 * browser. A refresh, a navigation, or another tab resumes the same running
 * clock; history is the closed-session record. The ticking display is a
 * projection of the server's timestamps - every transition re-derives the
 * truth server-side.
 */

function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

type FocusQuery = Promise<Record<string, string | string[] | undefined>>;

async function Focus({ searchParams }: { searchParams: FocusQuery }) {
  const query = await searchParams;
  const rawTask = typeof query.task === "string" ? query.task : undefined;
  await connection();
  const auth = await getAuthContext();
  // ?task= names a canonical task id (from the Work surface); anything that
  // is not a real workspace task falls back to the plain subject flow.
  const taskDetail = rawTask && /^[0-9a-f-]{36}$/i.test(rawTask) ? await getTaskDetail(auth, rawTask) : null;
  const [active, history] = await Promise.all([getActiveFocusSession(auth), listFocusHistory(auth)]);
  const activeTask = active?.taskId ? await getTaskDetail(auth, active.taskId) : null;

  return (
    <Screen
      title="Focus"
      description="One durable session at a time."
    >
      {active ? (
        <Panel
          title={activeTask ? activeTask.task.title : active.subject || "Focus session"}
          description={
            (activeTask ? `Task-linked session · status ${activeTask.task.status} · ` : "") +
            `Started ${active.startedAt.toISOString().slice(0, 16).replace("T", " ")}Z`
          }
        >
          <ActiveSessionControls
            key={`${active.id}:${active.version}`}
            session={{
              id: active.id,
              subject: active.subject,
              state: active.state as "running" | "paused",
              plannedMinutes: active.plannedMinutes,
              elapsedSeconds: active.elapsedSeconds,
              version: active.version,
              hasTask: !!active.taskId,
            }}
          />
        </Panel>
      ) : (
        <Panel title="Start a session">
          <StartSessionForm
            defaultSubject={rawTask && !taskDetail ? rawTask : undefined}
            task={taskDetail ? { id: taskDetail.task.id, title: taskDetail.task.title, status: taskDetail.task.status } : undefined}
          />
        </Panel>
      )}

      <Panel title="Recent sessions" description="Finished, interrupted and abandoned sessions, newest first.">
        <div className="divide-y divide-border">
          {history.map((session) => (
            <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-[13px] font-medium">{session.subject || "Focus session"}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDuration(session.elapsedSeconds)}
                  {session.plannedMinutes != null ? ` of ${session.plannedMinutes} planned` : ""}
                  {session.outcome ? ` · ${session.outcome}` : ""} · {session.startedAt.toISOString().slice(0, 16).replace("T", " ")}Z
                </p>
              </div>
              <Status>{session.state}</Status>
            </div>
          ))}
        </div>
        {!history.length ? (
          <Empty title="No sessions yet" description="Finished sessions land here with their real durations." />
        ) : null}
      </Panel>
    </Screen>
  );
}

export default function FocusPage({ searchParams }: { searchParams: FocusQuery }) {
  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 md:px-6">
        <Link href="/neuralflow/work" className="w-fit py-1 text-[13px] font-medium hover:underline">Back to Work</Link>
        <FeatureLinks />
      </div>
      <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening focus session…</p>}>
        <Focus searchParams={searchParams} />
      </Suspense>
    </>
  );
}
