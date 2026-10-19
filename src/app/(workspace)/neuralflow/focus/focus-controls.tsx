"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import {
  abandonSessionAction,
  finishSessionAction,
  pauseSessionAction,
  resumeSessionAction,
  startSessionAction,
} from "./actions";

/*
 * The live timer island. The ticking number is display-only, derived from the
 * server's durable clock fields (accumulatedSeconds + the open stretch since
 * lastResumedAt); every real transition is a server action that re-derives
 * the truth in Postgres, so a refresh loses nothing.
 */

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

type ActiveSession = {
  id: string;
  subject: string | null;
  state: "running" | "paused";
  plannedMinutes: number | null;
  /** Server-computed elapsed at render. The parent remounts this component
   * with key={version} after every transition, rebasing the ticker. */
  elapsedSeconds: number;
  version: number;
};

export function ActiveSessionControls({ session }: { session: ActiveSession & { hasTask?: boolean } }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Display-only drift counter: the server remains the clock of record and
  // every action re-derives elapsed time in Postgres.
  const [extraSeconds, setExtraSeconds] = useState(0);

  useEffect(() => {
    if (session.state !== "running") return;
    const timer = setInterval(() => setExtraSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [session.state]);

  const displaySeconds = session.elapsedSeconds + extraSeconds;

  const act = (action: (input: unknown) => Promise<{ ok: true } | { ok: false; error: string }>, extra: Record<string, unknown> = {}) => {
    setError(null);
    startTransition(async () => {
      const result = await action({ sessionId: session.id, expectedVersion: session.version, ...extra });
      if (!result.ok) setError(result.error);
    });
  };

  const finish = (form: HTMLFormElement | null) => {
    const data = form ? new FormData(form) : null;
    act(finishSessionAction, {
      whatChanged: String(data?.get("whatChanged") || ""),
      nextStep: String(data?.get("nextStep") || ""),
    });
  };

  const over = session.plannedMinutes != null && displaySeconds >= session.plannedMinutes * 60;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="font-mono text-4xl tabular-nums" aria-live="off">
          {formatClock(displaySeconds)}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {session.state === "running" ? "running" : "paused"}
          {session.plannedMinutes != null ? ` · planned ${session.plannedMinutes} min` : ""}
          {over ? " · past the planned interval" : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {session.state === "running" ? (
          <Button variant="outline" disabled={pending} onClick={() => act(pauseSessionAction)}>
            Pause
          </Button>
        ) : (
          <Button variant="outline" disabled={pending} onClick={() => act(resumeSessionAction)}>
            Resume
          </Button>
        )}
        {session.hasTask ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              finish(event.currentTarget);
            }}
          >
            <Field label="What changed? (saved against the task)">
              <Input name="whatChanged" maxLength={500} placeholder="What moved in this session" />
            </Field>
            <Field label="Next step (where you resume)">
              <Input name="nextStep" maxLength={500} placeholder="Where you pick this up" />
            </Field>
            <Button type="submit" disabled={pending}>
              Finish
            </Button>
          </form>
        ) : (
          <Button disabled={pending} onClick={() => act(finishSessionAction)}>
            Finish
          </Button>
        )}
        <Button variant="ghost" disabled={pending} onClick={() => act(abandonSessionAction)}>
          Abandon
        </Button>
      </div>
      {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
    </div>
  );
}

export function StartSessionForm({
  defaultSubject,
  task,
}: {
  defaultSubject?: string;
  task?: { id: string; title: string; status: string };
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        const plannedRaw = String(data.get("plannedMinutes") || "").trim();
        startTransition(async () => {
          const result = await startSessionAction({
            subject: String(data.get("subject") || ""),
            plannedMinutes: plannedRaw ? Number.parseInt(plannedRaw, 10) : null,
            ...(task ? { taskId: task.id } : {}),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          form.reset();
        });
      }}
    >
      {task ? (
        <div className="sm:col-span-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="text-[13px] font-medium">{task.title}</p>
          <p className="text-xs text-muted-foreground">Task-linked session · status {task.status} - finishing the session never completes the task.</p>
        </div>
      ) : null}
      <Field label="Focusing on">
        <Input name="subject" required={!task} maxLength={200} defaultValue={defaultSubject ?? task?.title} placeholder="What are you focusing on?" />
      </Field>
      <Field label="Planned minutes (optional)">
        <Input name="plannedMinutes" inputMode="numeric" placeholder="25" />
      </Field>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Starting…" : "Start focus"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}
