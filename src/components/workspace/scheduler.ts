import type { SchedulerPreferences } from "./types";

/*
 * Scheduler preferences are a local planning input, not a calendar provider
 * setting. Everything here is pure so the ranges can be checked without
 * rendering the settings screen.
 */
export const workStartRange = { min: 5, max: 12 } as const;
export const workEndRange = { min: 12, max: 23 } as const;
export const eveningRange = { min: 16, max: 22 } as const;

export const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const topicOptions = ["Writing", "Research", "Design", "Engineering", "Admin", "Learning", "Planning"] as const;

export function hourLabel(hour: number) {
  const wrapped = ((hour % 24) + 24) % 24;
  const suffix = wrapped < 12 ? "am" : "pm";
  const twelve = wrapped % 12 === 0 ? 12 : wrapped % 12;
  return `${twelve}${suffix}`;
}

export function weekdaySummary(weekdays: number[]) {
  const named = [...weekdays].sort((a, b) => a - b).map((day) => weekdayNames[day].slice(0, 3));
  if (named.length === 0) return "No working days selected";
  if (named.length === 7) return "Every day";
  return named.join(", ");
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/*
 * Returns the problems worth showing above the form. An empty list means the
 * values can be saved as they stand; a non-empty one means the save is refused
 * rather than silently corrected, so the owner sees what is wrong.
 */
export function schedulerProblems(scheduler: SchedulerPreferences): string[] {
  const problems: string[] = [];
  if (scheduler.workStartHour < workStartRange.min || scheduler.workStartHour > workStartRange.max) problems.push(`Work start hour must be between ${workStartRange.min} and ${workStartRange.max}.`);
  if (scheduler.workEndHour <= scheduler.workStartHour) problems.push("Work end hour must be later than the work start hour.");
  if (scheduler.suggestionsEnabled && scheduler.weekdays.length === 0) problems.push("Select at least one working day, or turn focus suggestions off.");
  return problems;
}

/*
 * The earliest hour a focus suggestion may be placed at: the work day start,
 * never before the floor the spec sets.
 */
export function earliestSuggestionHour(scheduler: SchedulerPreferences) {
  return clamp(scheduler.workStartHour, workStartRange.min, workStartRange.max);
}
