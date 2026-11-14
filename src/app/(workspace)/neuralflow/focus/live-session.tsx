"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import {
  confirmAbandonSessionAction,
  finishSessionAction,
  pauseSessionAction,
  requestAbandonSessionAction,
  resumeSessionAction,
} from "../work/actions";

/*
 * The live session's controls (spec §3) - ActiveSessionControls, absorbed
 * from Work and made tier-aware. The ticking number is display-only, derived
 * from the server's durable clock fields; every real transition is a server
 * action that re-derives the truth in Postgres, so a refresh loses nothing.
 * Deep hides Pause (the tier does not pause); a blocked Finish surfaces the
 * guard's own message, which says how much of the plan is left.
 */

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

type LiveSessionData = {
  id: string;
  taskId: string | null;
  subject: string | null;
  taskTitle: string | null;
  state: "running" | "paused";
  strictness: "normal" | "timeout" | "deep";
  plannedMinutes: number | null;
  /** Server-computed elapsed at render. The parent remounts this component
   * with key={id:version} after every transition, rebasing the ticker. */
  elapsedSeconds: number;
  version: number;
  /** Set once the abandon door has been requested (spec §2); null until then. */
  abandonRequestedAt: Date | null;
};

const tierLabels: Record<LiveSessionData["strictness"], string> = {
  normal: "Normal",
  timeout: "Timeout",
  deep: "Deep",
};

export function LiveSession({
  session,
  handoff,
  cooldownSeconds,
}: {
  session: LiveSessionData;
  handoff: { nextStep: string } | null;
  cooldownSeconds: number;
}) {
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
  const hasTask = Boolean(session.taskId);
  const deep = session.strictness === "deep";

  // The abandon door's countdown. The server owns the real check - a confirm
  // that arrives early gets the guard's error - this only keeps the button
  // honest between renders.
  const requestedAt = session.abandonRequestedAt;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!requestedAt) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [requestedAt]);
  const abandonRemaining = requestedAt
    ? Math.max(0, cooldownSeconds - Math.floor((nowMs - requestedAt.getTime()) / 1000))
    : 0;

  const act = (
    action: (input: unknown) => Promise<{ ok: true } | { ok: false; error: string }>,
    extra: Record<string, unknown> = {},
  ) => {
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
    <section className="panel min-w-0 rounded-xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-body-dense font-medium">{session.subject ?? session.taskTitle ?? "Focus session"}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {tierLabels[session.strictness]} focus
            {session.plannedMinutes != null ? ` · planned ${session.plannedMinutes} min` : ""}
            {session.state === "paused" ? " · paused" : over ? " · past the planned interval" : ""}
          </p>
        </div>
        <span className="inline-flex min-h-6 items-center rounded-sm border border-border bg-muted/60 px-2 text-data font-medium">
          {tierLabels[session.strictness]}
        </span>
      </div>
      {handoff ? (
        <p className="mb-3 border-b border-border pb-3 text-body-dense text-muted-foreground">
          Last time: {handoff.nextStep}
        </p>
      ) : null}
      <div className="grid gap-4">
        <div className="flex flex-col items-center gap-1 rounded-lg border border-border py-8">
          <p className="text-sm text-muted-foreground">{session.state === "running" ? "Focusing" : "Paused"}</p>
          <span
            role="timer"
            className="readout text-4xl tabular-nums"
            aria-label={`${Math.floor(displaySeconds / 60)} minutes ${displaySeconds % 60} seconds elapsed`}
          >
            {formatClock(displaySeconds)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.state === "running" ? (
            deep ? null : (
              <Button variant="outline" disabled={pending} onClick={() => act(pauseSessionAction)}>
                Pause
              </Button>
            )
          ) : (
            <Button variant="outline" disabled={pending} onClick={() => act(resumeSessionAction)}>
              Resume
            </Button>
          )}
          {hasTask ? (
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
            <Button disabled={pending} onClick={() => finish(null)}>
              Finish
            </Button>
          )}
          {requestedAt ? (
            <div className="w-full rounded-lg border border-dashed border-border p-3">
              <p className="text-body-dense font-medium">Abandon requested</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Nothing is lost while the door is open - the timer keeps running. The state is in Postgres, not a modal,
                so closing this tab changes nothing.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="ghost"
                  disabled={pending || abandonRemaining > 0}
                  onClick={() => act(confirmAbandonSessionAction)}
                >
                  Confirm abandon
                </Button>
                <span className="text-xs text-muted-foreground">
                  {abandonRemaining > 0 ? `You can abandon in ${abandonRemaining}s` : "The door is open."}
                </span>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={pending} onClick={() => act(requestAbandonSessionAction)}>
              Abandon
            </Button>
          )}
        </div>
        {error ? (
          <p className="text-destructive text-body-dense" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
