import type { CalendarEvent, Focus, Task } from "@/components/workspace/types";
import { advanceRecurrence } from "@/components/workspace/tasks";

// Canonical task vocabulary lives in the shared workspace layer so the Command
// Center queue and the NeuralFlow views cannot disagree on status names.
export { statusLabels, taskStatuses } from "@/components/workspace/tasks";
/* "1 task", "3 tasks": interface counts never read as "1 tasks". */
export function countLabel(count: number, singular: string, plural = `${singular}s`) { return `${count} ${count === 1 ? singular : plural}`; }
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00`);
  parsed.setDate(parsed.getDate() + days);
  return localDate(parsed);
}
export function validDate(date?: string): date is string { return !!date && /^\d{4}-\d{2}-\d{2}$/.test(date) && localDate(new Date(`${date}T12:00:00`)) === date; }
export function minuteOfDay(time: string) { const [hours, minutes] = time.split(":").map(Number); return hours * 60 + minutes; }
export function timeLabel(minutes: number) { return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }
export function eventEnd(event: Pick<CalendarEvent, "date" | "start" | "duration">) {
  const end = new Date(new Date(`${event.date}T${event.start}:00`).getTime() + event.duration * 60000);
  return { date: localDate(end), time: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}` };
}
export function hasConflict(events: CalendarEvent[], date: string, start: string, duration: number, exceptId?: string) {
  const from = new Date(`${date}T${start}:00`).getTime() / 60000;
  return events.some((event) => {
    const eventStart = new Date(`${event.date}T${event.start}:00`).getTime() / 60000;
    return event.id !== exceptId && from < eventStart + event.duration && from + duration > eventStart;
  });
}
export function calendarDaySegments(events: CalendarEvent[], day: string) {
  const segments = events.flatMap((event) => {
    const end = eventEnd(event);
    if (event.date > day || end.date < day || (end.date === day && end.time === "00:00")) return [];
    const from = event.date < day ? 0 : minuteOfDay(event.start);
    const to = end.date > day ? 1440 : minuteOfDay(end.time);
    return to > from ? [{ event, from, to }] : [];
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  const lanes: number[] = [];
  const positioned = segments.map((segment) => {
    let lane = lanes.findIndex((until) => until <= segment.from);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = segment.to;
    return { ...segment, lane };
  });
  return positioned.map((segment) => ({ ...segment, laneCount: lanes.length }));
}
/*
 * A repeating block is stored once. Expansion materialises the dates it lands
 * on, so every view sees the same series and cancelling one date is an
 * exception rather than a duplicated record.
 */
export function expandRecurrence(event: CalendarEvent, through: string): CalendarEvent[] {
  if (!event.recurrence) return [event];
  const spans = (start: string, end: string) => Math.round((new Date(`${end}T12:00:00`).getTime() - new Date(`${start}T12:00:00`).getTime()) / 86400000);
  const length = event.endDate ? spans(event.date, event.endDate) : 0;
  const occurrences: CalendarEvent[] = [];
  let date = event.date;
  for (let guard = 0; guard < 400 && date <= through; guard++) {
    if (!event.exceptionDates?.includes(date)) occurrences.push({ ...event, date, endDate: event.endDate ? shiftDate(date, length) : undefined });
    const next = advanceRecurrence(date, event.recurrence);
    if (!next) break;
    date = next;
  }
  return occurrences;
}

export function expandEvents(events: CalendarEvent[], through: string) {
  return events.flatMap((event) => expandRecurrence(event, through));
}

export type ScheduleProposal = { taskId: string; taskVersion: number; title: string; date: string; start: string; duration: number; reason: string };
export function proposeSchedule(tasks: Task[], events: CalendarEvent[], date: string, start: string, end: string, limit = 5): ScheduleProposal[] {
  const proposals: ScheduleProposal[] = [];
  const reserved = [...events];
  const priorities = { High: 0, Medium: 1, Low: 2 };
  const eligible = tasks.filter((task) => ["READY", "IN_PROGRESS"].includes(task.status) && !events.some((event) => event.taskId === task.id && event.date === date));
  eligible.sort((a, b) => priorities[a.priority] - priorities[b.priority] || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.title.localeCompare(b.title));
  for (const task of eligible) {
    const duration = Math.max(15, Math.ceil(task.estimate / 5) * 5);
    for (let time = minuteOfDay(start); time + duration <= minuteOfDay(end); time += 15) {
      const blockStart = timeLabel(time);
      if (hasConflict(reserved, date, blockStart, duration)) continue;
      proposals.push({ taskId: task.id, taskVersion: task.version, title: task.title, date, start: blockStart, duration, reason: `${task.priority} priority; ${task.estimate} minute estimate. Fits the selected window around local preview blocks only.` });
      reserved.push({ id: `proposal-${task.id}`, title: task.title, date, start: blockStart, duration, taskId: task.id, provider: "local" });
      break;
    }
    if (proposals.length >= limit) break;
  }
  return proposals;
}
export function focusRemaining(focus: Focus, now: number) { return focus.status === "paused" ? focus.remaining : Math.max(0, focus.remaining - Math.floor(Math.max(0, now - focus.startedAt) / 1000)); }
export function focusRewardKey(focus: Focus) { return `neuralflow-focus:${focus.taskId}:${focus.startedAt}:${focus.duration}:${focus.completed}`; }
export function brainDumpLines(text: string): string[] {
  return [...new Set(text.split(/\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean))].slice(0, 30);
}
