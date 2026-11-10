import type { WorkspaceState } from "./types";

/*
 * The reward ledger is the only source of truth. Focus records are derived
 * from it and cached nowhere, so a reward cannot be counted twice and a
 * projection can never disagree with the entries beneath it.
 */

export type FocusRecord = { id: string; taskId: string; minutes: number; earnedAt: string; day: string };

function localDay(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/*
 * Session keys are written by the focus screen as
 * `neuralflow-focus:<taskId>:<startedAt>:<durationSeconds>:<completed>`.
 * A key that does not match is kept out of the totals rather than parsed
 * loosely, so a future format change shows up as a missing record, not as a
 * wrong number.
 */
export function focusRecords(rewards: WorkspaceState["rewards"]): FocusRecord[] {
  return rewards.flatMap((reward) => {
    const parts = reward.sessionId.split(":");
    if (parts.length !== 5 || parts[0] !== "neuralflow-focus") return [];
    const minutes = Number(parts[3]);
    return [
      {
        id: reward.id,
        taskId: parts[1],
        minutes: Number.isFinite(minutes) ? minutes : 0,
        earnedAt: reward.earnedAt,
        day: localDay(reward.earnedAt),
      },
    ];
  });
}
