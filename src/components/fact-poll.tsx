"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "cn";
import { buildRotation, selectFactPool, type PollFact } from "@/lib/poll-facts";

const FACT_INTERVAL_MS = 7_000;

/*
 * The polling wait surface. A status line stays honest about the work while a
 * fact rotates beneath it, so a long wait reads instead of spins. Selection is
 * biased by the caller's topics: a deep tag match narrows the deck, a shallow
 * one falls back to all of it, and neither pool repeats a fact before it is
 * exhausted. The fact crossfade runs a little longer than motionTransition —
 * the 200 ms house ceiling exists so motion never delays an action, and an
 * ambient rotation delays nothing.
 */

function useFactRotation(topics: string[], extra?: PollFact[]): PollFact | null {
  // Callers pass inline literal arrays; the joined key keeps the pool (and so
  // the rotation) stable across their re-renders. The extras enter the memo
  // through a map keyed on their ids: same ids, same array object, so a
  // re-render holding the same facts never restarts the walk, while a
  // refetch with new facts replaces the pool.
  const topicKey = topics.join(",");
  const extraKey = extra?.map((fact) => fact.id).join(",") ?? "";
  const pool = useMemo(() => {
    const byId = new Map(extra?.map((fact) => [fact.id, fact]));
    return selectFactPool(
      topicKey.split(",").filter(Boolean),
      extraKey
        ? extraKey
            .split(",")
            .map((id) => byId.get(id))
            .filter((fact): fact is PollFact => Boolean(fact))
        : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extraKey is the identity; extra only supplies the rows
  }, [topicKey, extraKey]);

  const remainingRef = useRef<PollFact[]>([]);
  const [fact, setFact] = useState<PollFact | null>(null);

  const draw = useCallback(() => {
    if (remainingRef.current.length === 0) remainingRef.current = buildRotation(pool);
    const [next, ...rest] = remainingRef.current;
    remainingRef.current = rest;
    setFact(next);
  }, [pool]);

  useEffect(() => {
    remainingRef.current = [];
    draw();
    const timer = setInterval(draw, FACT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [draw]);

  return fact;
}

function BreathingDots() {
  const reduced = useReducedMotion();
  return (
    <span aria-hidden className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted-foreground/60 size-1 rounded-full"
          animate={reduced ? undefined : { opacity: [0.25, 0.9, 0.25] }}
          transition={reduced ? undefined : { duration: 1.8, repeat: Infinity, delay: i * 0.3, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

export function FactPoll({
  label,
  topics = [],
  extraFacts,
  compact = false,
  className,
}: {
  label: string;
  /** Lowercase keywords biasing the fact deck toward the wait's subject. */
  topics?: string[];
  /** Job-drafted suggestions merged into the pool; the deck stays the base. */
  extraFacts?: PollFact[];
  compact?: boolean;
  className?: string;
}) {
  const fact = useFactRotation(topics, extraFacts);
  const reduced = useReducedMotion();

  if (!fact) return null;

  const factMotion = reduced
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -4 },
        transition: { duration: 0.45, ease: [0.25, 0.1, 0.25, 1] as const },
      };

  if (compact) {
    return (
      <div role="status" className={cn("text-muted-foreground flex items-baseline gap-2 text-body-dense", className)}>
        <span className="shrink-0">{label}</span>
        <span aria-hidden className="text-border">
          ·
        </span>
        <span aria-live="polite" className="line-clamp-1 min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={fact.id} {...factMotion} className="block truncate italic">
              {fact.text}
            </motion.span>
          </AnimatePresence>
        </span>
        <BreathingDots />
      </div>
    );
  }

  return (
    <div role="status" className={cn("panel space-y-2 rounded-xl p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-body-dense text-muted-foreground">{label}</p>
        <BreathingDots />
      </div>
      <div aria-live="polite" className="text-body-dense min-h-10 italic text-muted-foreground/90">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={fact.id} {...factMotion}>
            {fact.text}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
