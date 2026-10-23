"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { FormingStone, StoneStage } from "@/components/products/neuralflow/stone-art";
import { formingProgress, stoneForReward } from "@/components/products/neuralflow/stones";
import {
  abandonSessionAction,
  finishSessionAction,
  pauseSessionAction,
  resumeSessionAction,
  startSessionAction,
} from "./actions";

/*
 * The focus-session islands on Work (the focus surface folded here in the IA
 * simplification). The ticking number is display-only, derived from the
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

/** The OS-level motion preference; the stage's sheen honours it like the preview screens do. */
function useReduceMotion() {
  // Lazy initializer: reading matchMedia at mount is an external-system read,
  // not cascading state; the listener only reacts to later changes.
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const clarityStone = stoneForReward("Clarity stone");

export function ActiveSessionControls({ session }: { session: ActiveSession & { hasTask?: boolean } }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reduceMotion = useReduceMotion();
  // Display-only drift counter: the server remains the clock of record and
  // every action re-derives elapsed time in Postgres.
  const [extraSeconds, setExtraSeconds] = useState(0);

  useEffect(() => {
    if (session.state !== "running") return;
    const timer = setInterval(() => setExtraSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [session.state]);

  const displaySeconds = session.elapsedSeconds + extraSeconds;
  const plannedSeconds = session.plannedMinutes != null ? session.plannedMinutes * 60 : 25 * 60;

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
      <StoneStage
        caption={session.state === "running" ? "Focusing" : "Paused"}
        sub={
          <span role="timer" aria-label={`${Math.floor(displaySeconds / 60)} minutes ${displaySeconds % 60} seconds elapsed`}>
            {formatClock(displaySeconds)}
          </span>
        }
      >
        {clarityStone ? (
          <FormingStone stone={clarityStone} progress={formingProgress(displaySeconds, plannedSeconds)} reduceMotion={reduceMotion} />
        ) : null}
      </StoneStage>
      <p className="text-[13px] text-muted-foreground">
        {session.state === "running" ? "Running" : "Paused"}
        {session.plannedMinutes != null ? ` · planned ${session.plannedMinutes} min` : ""}
        {over ? " · past the planned interval" : ""}
      </p>
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

/*
 * The task detail's Focus action: one click starts a task-linked session.
 * A session already running comes back as the domain's conflict message, so
 * the second click never silently replaces the live one.
 */
export function FocusTaskButton({ task }: { task: { id: string; title: string } }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await startSessionAction({ subject: task.title, plannedMinutes: null, taskId: task.id });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        Start focus
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
