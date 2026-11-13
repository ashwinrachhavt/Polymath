/*
 * How a study session is chosen from what is due. Pure: no database, no clock
 * of its own, so the rules can be read and tested without either.
 *
 *   priority  How overdue the item is (0 to 1, saturating at 14 days late),
 *             plus twice the urgency of the soonest dated mission that covers
 *             its concept (0 at 14 or more days out, 1 on the day). A mission
 *             item due on the day outranks anything merely overdue.
 *   budget    Items are taken in priority order until the time estimate fills
 *             the budget (10 minutes by default): about 20 seconds for a
 *             flashcard, 40 for a quiz question. Never fewer than one.
 *   order     Interleaved. Walking the chosen items by priority, an item
 *             whose source matches the one just shown waits for the next
 *             item from a different source, so a session never runs one
 *             document's cards back to back while another source is waiting.
 */

type StudyKind = "flashcard" | "quiz_question";

export type StudyCandidate = {
  kind: StudyKind;
  id: string;
  /** The document the item came from; the interleaving key. */
  sourceKey: string;
  dueAt: Date;
  conceptIds: readonly string[];
};

export type MissionDeadline = { conceptIds: ReadonlySet<string>; daysLeft: number };

export const DEFAULT_STUDY_MINUTES = 10;
export const MISSION_WINDOW_DAYS = 14;
const OVERDUE_SATURATION_DAYS = 14;
const MAX_SESSION_ITEMS = 40;
const SECONDS_PER_ITEM: Record<StudyKind, number> = { flashcard: 20, quiz_question: 40 };
const DAY_MS = 24 * 60 * 60 * 1000;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 0 when the date is past or 14+ days away, rising to 1 on the day itself. */
export function missionUrgency(daysLeft: number): number {
  return daysLeft < 0 ? 0 : clamp01((MISSION_WINDOW_DAYS - daysLeft) / MISSION_WINDOW_DAYS);
}

export function priorityOf(candidate: StudyCandidate, missions: readonly MissionDeadline[], now: Date): number {
  const overdue = clamp01((now.getTime() - candidate.dueAt.getTime()) / DAY_MS / OVERDUE_SATURATION_DAYS);
  const urgency = missions
    .filter((mission) => candidate.conceptIds.some((id) => mission.conceptIds.has(id)))
    .reduce((best, mission) => Math.max(best, missionUrgency(mission.daysLeft)), 0);
  return overdue + 2 * urgency;
}

export function estimatedSeconds(items: readonly Pick<StudyCandidate, "kind">[]): number {
  return items.reduce((sum, item) => sum + SECONDS_PER_ITEM[item.kind], 0);
}

/** Highest priority first; ties go to the longer-overdue item, then the id, so the order is stable. */
function byPriority<T extends StudyCandidate>(items: readonly T[], priority: Map<T, number>): T[] {
  return [...items].sort(
    (a, b) => priority.get(b)! - priority.get(a)! || a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id),
  );
}

export function interleave<T extends Pick<StudyCandidate, "sourceKey">>(ordered: readonly T[]): T[] {
  const remaining = [...ordered];
  const out: T[] = [];
  while (remaining.length > 0) {
    const last = out[out.length - 1];
    const at = last ? remaining.findIndex((item) => item.sourceKey !== last.sourceKey) : 0;
    out.push(...remaining.splice(at === -1 ? 0 : at, 1));
  }
  return out;
}

export function chooseSession<T extends StudyCandidate>(
  candidates: readonly T[],
  input: { missions: readonly MissionDeadline[]; now: Date; minutes?: number },
): T[] {
  const priority = new Map(
    candidates.map((candidate) => [candidate, priorityOf(candidate, input.missions, input.now)]),
  );
  const budget = (input.minutes ?? DEFAULT_STUDY_MINUTES) * 60;
  const chosen: T[] = [];
  let spent = 0;
  for (const candidate of byPriority(candidates, priority)) {
    const cost = SECONDS_PER_ITEM[candidate.kind];
    if (chosen.length > 0 && (spent + cost > budget || chosen.length >= MAX_SESSION_ITEMS)) break;
    chosen.push(candidate);
    spent += cost;
  }
  return interleave(chosen);
}
