"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "cn";
import { motionTransition } from "@/components/motion-config";

/*
 * The shared presentation contract for background work (the wave-1 research's
 * WorkStatus + useWorkPoll): every workflow maps its own status onto four
 * phases, the label is a server-authored sentence the client renders
 * verbatim, and counts are structured numbers so they render with
 * tabular-nums. No spinners anywhere - a status line is the progress UI,
 * and the phase change is the only motion: one 180 ms transform/opacity
 * rise, honoring the root reduced-motion config.
 */

export type WorkPhase = "queued" | "working" | "done" | "failed";

export type WorkState = {
  phase: WorkPhase;
  /** Server-authored sentence. The client never writes workflow copy. */
  label: string;
  /** Structured counts; zero segments are skipped, the numbers render tabular. */
  count?: { queued: number; reviewing?: number };
};

function sameWorkState(a: WorkState, b: WorkState): boolean {
  return (
    a.phase === b.phase &&
    a.label === b.label &&
    a.count?.queued === b.count?.queued &&
    a.count?.reviewing === b.count?.reviewing
  );
}

/** The status line for background work. Renders nothing while idle. */
export function WorkStatus({ state, className }: { state: WorkState | null; className?: string }) {
  if (!state) return null;
  const count = state.count;
  const segments = count
    ? [count.queued > 0 ? `${count.queued} queued` : "", count.reviewing ? `${count.reviewing} in review` : ""].filter(
        Boolean,
      )
    : [];
  return (
    <motion.p
      key={state.phase}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransition}
      role={state.phase === "failed" ? "alert" : "status"}
      className={cn(
        "text-body-dense",
        state.phase === "failed" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {state.label}
      {segments.length > 0 ? (
        <span className="tabular-nums">
          {" · "}
          {segments.join(" · ")}
        </span>
      ) : null}
    </motion.p>
  );
}

type WorkPollRead = (ids: string[]) => Promise<Record<string, WorkState>>;

type WorkPollOptions = {
  /**
   * The ids whose work is still owed; empty disarms the poll. Pass a
   * memoized array (or derive it from a joined key, as the vault does):
   * the interval re-arms on identity changes, so a per-render literal
   * would pace fetches by render speed instead of the interval.
   */
  ids: string[];
  /** The batch status read. Must be stable (a module function or useCallback). */
  read: WorkPollRead;
  intervalMs?: number;
  giveUpMs?: number;
  /** The honest sentence when the ceiling passes with the work still owed. */
  giveUpLabel: string;
};

/**
 * The vault's readiness poll, generalized: arm only while ids are non-empty,
 * read immediately then on the interval, let failed ticks stay silent so the
 * next interval retries, stop when every polled id settles, and give up
 * honestly at the ceiling instead of spinning forever against a stuck queue.
 * A fresh arm answers fresh: states from a finished arm are wiped, so a
 * re-queued id can never show the previous run's words.
 */
export function useWorkPoll({ ids, read, intervalMs = 2_000, giveUpMs = 5 * 60_000, giveUpLabel }: WorkPollOptions): {
  states: Record<string, WorkState>;
  gaveUp: boolean;
} {
  const pendingKey = useMemo(() => ids.join(","), [ids]);
  const [states, setStates] = useState<Record<string, WorkState>>({});
  const [gaveUp, setGaveUp] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const armIdsRef = useRef<string[]>([]);

  // A fresh arm answers fresh: wipe states when the arm changes, using the
  // React-documented render-time reset. Without it, a re-armed id could show
  // the previous run's words and the settle effect below could stop a new arm
  // on stale terminal answers before its first read returns.
  const [armKey, setArmKey] = useState(pendingKey);
  if (armKey !== pendingKey) {
    setArmKey(pendingKey);
    setStates({});
    setGaveUp(false);
  }

  useEffect(() => {
    if (!pendingKey) return;
    const pollIds = pendingKey.split(",");
    const startedAt = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    stopRef.current = stop;
    armIdsRef.current = pollIds;

    const tick = async () => {
      if (Date.now() - startedAt > giveUpMs) {
        // The ceiling is honesty under stall: say so, stop polling, and let
        // the surface catch up on its own.
        stop();
        setGaveUp(true);
        setStates((prev) => {
          const next = { ...prev };
          for (const id of pollIds) {
            const current = next[id];
            if (!current || current.phase === "queued" || current.phase === "working") {
              next[id] = { phase: "working", label: giveUpLabel };
            }
          }
          return next;
        });
        return;
      }
      let result: Record<string, WorkState>;
      try {
        result = await read(pollIds);
      } catch {
        // The poll is a status read, not a mutation: a failed tick is silent
        // and the next interval retries.
        return;
      }
      setStates((prev) => {
        // Write only when a state actually moved: returning prev keeps quiet
        // ticks from re-rendering the consumer.
        let changed = false;
        const next = { ...prev };
        for (const [id, state] of Object.entries(result)) {
          const before = prev[id];
          if (before && sameWorkState(before, state)) continue;
          changed = true;
          next[id] = state;
        }
        return changed ? next : prev;
      });
    };

    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    return stop;
  }, [pendingKey, read, intervalMs, giveUpMs, giveUpLabel]);

  // Terminal states stop the poll; a changed pending key re-arms it.
  useEffect(() => {
    if (armIdsRef.current.length === 0) return;
    const settled = armIdsRef.current.every(
      (id) => states[id] && (states[id].phase === "done" || states[id].phase === "failed"),
    );
    if (settled) stopRef.current?.();
  }, [states]);

  return { states, gaveUp };
}
