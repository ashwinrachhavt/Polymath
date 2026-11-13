"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "cn";
import type { GenerationJobStatus } from "@/domains/jobs/state";

/*
 * A job's status as one small mark: an arc that turns while the work runs,
 * and on completion closes into a ring and draws a check (the spinner-to-check
 * morph). Failure and stop draw a cross the same way. Queued work is a still,
 * dashed ring: nothing is happening yet, so nothing moves.
 *
 * The morph is one element changing state, never a swap of icons, so a job
 * that finishes while someone watches reads as the same thing completing.
 * Reduced motion keeps the end states and drops the travel.
 */

const RING = { cx: 8, cy: 8, r: 6.5 } as const;
const CHECK = "M5 8.3 L7.1 10.3 L11 6";
const CROSS = "M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2";
const EASE = [0.22, 1, 0.36, 1] as const;

export function JobMark({ status, className }: { status: GenerationJobStatus; className?: string }) {
  const reduced = useReducedMotion();
  const settled = status === "ready" || status === "failed" || status === "cancelled";
  const tone =
    status === "ready" ? "text-foreground" : status === "failed" ? "text-destructive" : "text-muted-foreground";
  const label =
    status === "ready"
      ? "Done"
      : status === "failed"
        ? "Failed"
        : status === "cancelled"
          ? "Stopped"
          : status === "running"
            ? "Working"
            : "Waiting";

  return (
    <motion.svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      data-job-mark={status}
      className={cn("size-4 shrink-0", tone, className)}
      initial={false}
      animate={settled && !reduced ? { scale: [1, 1.18, 1] } : { scale: 1 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      {status === "queued" ? (
        <circle {...RING} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2.6" opacity={0.7} />
      ) : (
        <>
          <circle {...RING} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.18} />
          <motion.circle
            {...RING}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            style={{ originX: "50%", originY: "50%" }}
            initial={false}
            animate={
              settled
                ? { pathLength: 1, rotate: 0 }
                : reduced
                  ? { pathLength: 0.3, rotate: 0 }
                  : { pathLength: 0.3, rotate: 360 }
            }
            transition={
              settled
                ? { pathLength: { duration: 0.22, ease: EASE }, rotate: { duration: 0 } }
                : { rotate: { duration: 0.9, ease: "linear", repeat: Infinity }, pathLength: { duration: 0.2 } }
            }
          />
          {settled ? (
            <motion.path
              d={status === "ready" ? CHECK : CROSS}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduced ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.26, delay: reduced ? 0 : 0.16, ease: EASE }}
            />
          ) : null}
        </>
      )}
    </motion.svg>
  );
}
