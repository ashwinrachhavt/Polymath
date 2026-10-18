import type { WorkspaceState } from "./types";

/*
 * The reward ledger is the only source of truth. Streaks, shards and charts are
 * derived from it and cached nowhere, so a reward cannot be counted twice and a
 * projection can never disagree with the entries beneath it.
 */

export type FocusRecord = { id: string; taskId: string; minutes: number; earnedAt: string; day: string };
export const stonesPerShard = 5;

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
    return [{ id: reward.id, taskId: parts[1], minutes: Number.isFinite(minutes) ? minutes : 0, earnedAt: reward.earnedAt, day: localDay(reward.earnedAt) }];
  });
}

/*
 * Consecutive recorded days ending on `today` or the day before it. The
 * previous-day allowance means an owner opening the product in the morning
 * still sees yesterday's streak instead of zero before they have worked.
 */
export function focusStreak(rewards: WorkspaceState["rewards"], today: string) {
  const days = new Set(focusRecords(rewards).map((record) => record.day));
  if (!days.size) return { current: 0, longest: 0 };
  const shift = (date: string, delta: number) => {
    const parsed = new Date(`${date}T12:00:00`);
    parsed.setDate(parsed.getDate() + delta);
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  };
  let current = 0;
  let cursor = days.has(today) ? today : shift(today, -1);
  while (days.has(cursor)) { current += 1; cursor = shift(cursor, -1); }
  const ordered = [...days].sort();
  let longest = 1;
  let run = 1;
  for (let index = 1; index < ordered.length; index += 1) {
    run = ordered[index] === shift(ordered[index - 1], 1) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return { current, longest };
}

/*
 * Shards are a deterministic accounting of stones, not a second currency with
 * its own state: five recorded stones fuse into one shard, and the remainder
 * stays visible so the total always reconciles with the ledger length.
 */
export function shardLedger(rewards: WorkspaceState["rewards"]) {
  const shards = Math.floor(rewards.length / stonesPerShard);
  return { shards, remainder: rewards.length % stonesPerShard, toNextShard: rewards.length % stonesPerShard === 0 ? stonesPerShard : stonesPerShard - (rewards.length % stonesPerShard) };
}

export function minutesByDay(rewards: WorkspaceState["rewards"], from: string, through: string) {
  const records = focusRecords(rewards);
  const days: { day: string; minutes: number; sessions: number }[] = [];
  const seen = new Map<string, { minutes: number; sessions: number }>();
  for (const record of records) {
    if (record.day < from || record.day > through) continue;
    const entry = seen.get(record.day) || { minutes: 0, sessions: 0 };
    entry.minutes += record.minutes;
    entry.sessions += 1;
    seen.set(record.day, entry);
  }
  const cursor = new Date(`${from}T12:00:00`);
  const last = new Date(`${through}T12:00:00`);
  while (cursor <= last) {
    const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    days.push({ day, ...(seen.get(day) || { minutes: 0, sessions: 0 }) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
