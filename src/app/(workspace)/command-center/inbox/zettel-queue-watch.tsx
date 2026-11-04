"use client";

import { useWorkPoll, WorkStatus } from "@/components/work-status";
import { zettelQueueStatusAction } from "./zettel-actions";

/**
 * The live half of a zettelize verb's outcome: "Proposing ideas…" while
 * outbox rows are owed, then the in-review count once they land. It renders
 * nothing until the first read answers, and stops itself when the queue is
 * clear - a status read, never a second queue. The click's own receipt (the
 * queued/skipped summary and the review link) is the surface's static line
 * above it.
 */
export function ZettelQueueWatch() {
  const { states } = useWorkPoll({
    ids: ["zettel-queue"],
    read: async () => {
      const status = await zettelQueueStatusAction();
      if (!status.ok) throw new Error(status.message);
      return {
        phase: status.phase,
        label: status.label,
        ...(status.reviewing > 0 ? { count: { reviewing: status.reviewing } } : {}),
      };
    },
    intervalMs: 2_000,
    giveUpMs: 2 * 60_000,
    giveUpLabel: "Still proposing in the background - the Ideas queue will catch up.",
  });

  return <WorkStatus state={states["zettel-queue"] ?? null} />;
}
