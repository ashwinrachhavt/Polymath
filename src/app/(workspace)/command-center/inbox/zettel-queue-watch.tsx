"use client";

import { useWorkPoll, WorkStatus, type WorkState } from "@/components/work-status";
import { zettelQueueStatusAction } from "./zettel-actions";

/** How long the verb watches the queue before it says so honestly. */
const GIVE_UP_MS = 2 * 60_000;

/**
 * The live half of a zettelize verb's outcome: "Creating zettels…" while
 * outbox rows are owed, then quiet once the cards have landed in the Ideas
 * page. It renders nothing until the first read answers, and stops itself
 * when the queue is clear - a status read, never a second queue. The click's
 * own receipt (the queued/skipped summary and the Ideas link) is the
 * surface's static line above it.
 */
export function ZettelQueueWatch() {
  const { states } = useWorkPoll({
    ids: ["zettel-queue"],
    read: async () => {
      const status = await zettelQueueStatusAction();
      if (!status.ok) throw new Error(status.message);
      const state: WorkState = { phase: status.phase, label: status.label };
      return { "zettel-queue": state };
    },
    intervalMs: 2_000,
    giveUpMs: GIVE_UP_MS,
    giveUpLabel: "Still creating zettels in the background - they will appear in Ideas.",
  });

  return <WorkStatus state={states["zettel-queue"] ?? null} />;
}
