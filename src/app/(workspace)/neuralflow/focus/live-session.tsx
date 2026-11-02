"use client";

import { useEffect, useState, useTransition } from "react";
import { useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { FormingStone, StoneStage } from "@/components/products/neuralflow/stone-art";
import { formingProgress, stoneForReward } from "@/components/products/neuralflow/stones";
import { abandonSessionAction, finishSessionAction, pauseSessionAction, resumeSessionAction } from "../work/actions";

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
};

const tierLabels: Record<LiveSessionData["strictness"], string> = {
  normal: "Normal",
  timeout: "Timeout",
  deep: "Deep",
};

const clarityStone = stoneForReward("Clarity stone");

export function LiveSession({ session, handoff }: { session: LiveSessionData; handoff: { nextStep: string } | null }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The OS-level motion preference; the stage's sheen honours it like the preview screens do.
  const reduceMotion = useReducedMotion() ?? false;
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
  const hasTask = Boolean(session.taskId);
  const deep = session.strictness === "deep";

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
          <h2 className="text-[13px] font-medium">{session.subject ?? session.taskTitle ?? "Focus session"}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {tierLabels[session.strictness]} focus
            {session.plannedMinutes != null ? ` · planned ${session.plannedMinutes} min` : ""}
            {session.state === "paused" ? " · paused" : over ? " · past the planned interval" : ""}
          </p>
        </div>
        <span className="inline-flex min-h-6 items-center rounded-sm border border-border bg-muted/60 px-2 text-[11px] font-medium">
          {tierLabels[session.strictness]}
        </span>
      </div>
      {handoff ? (
        <p className="mb-3 border-b border-border pb-3 text-[13px] text-muted-foreground">
          Last time: {handoff.nextStep}
        </p>
      ) : null}
      <div className="grid gap-4">
        <StoneStage
          caption={session.state === "running" ? "Focusing" : "Paused"}
          sub={
            <span
              role="timer"
              aria-label={`${Math.floor(displaySeconds / 60)} minutes ${displaySeconds % 60} seconds elapsed`}
            >
              {formatClock(displaySeconds)}
            </span>
          }
        >
          {clarityStone ? (
            <FormingStone
              stone={clarityStone}
              progress={formingProgress(displaySeconds, plannedSeconds)}
              reduceMotion={reduceMotion}
            />
          ) : null}
        </StoneStage>
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
          <Button variant="ghost" disabled={pending} onClick={() => act(abandonSessionAction)}>
            Abandon
          </Button>
        </div>
        {error ? (
          <p className="text-destructive text-[13px]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
