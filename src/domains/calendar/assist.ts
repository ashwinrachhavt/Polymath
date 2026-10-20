import { findFreeSlot, type Interval } from "./slots";

/*
 * Calendar Assist answers, computed from the week's real events. No model
 * call: the four questions the panel suggests are arithmetic over the data,
 * so the answer is exact and works offline. A free-form question that matches
 * none of them says so instead of guessing.
 */

export type AssistEvent = { title: string; startsAt: string; endsAt: string; taskId: string | null };

export type AssistContext = {
  events: AssistEvent[];
  now: Date;
  /** Local offset east of UTC in minutes (-420 for PDT). */
  utcOffsetMinutes: number;
};

const DAY = 86_400_000;

function localDay(ms: number, offset: number) {
  return Math.floor((ms + offset * 60_000) / DAY);
}
function dayLabel(day: number) {
  return new Date(day * DAY).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
function hm(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}
function minutesOf(e: AssistEvent) {
  return Math.round((new Date(e.endsAt).getTime() - new Date(e.startsAt).getTime()) / 60_000);
}
function timeLabel(d: Date, offset: number) {
  return new Date(d.getTime() + offset * 60_000).toLocaleString("en-US", {
    weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC",
  });
}

export function busiestDay(ctx: AssistContext): string {
  if (ctx.events.length === 0) return "Nothing is scheduled this week.";
  const totals = new Map<number, number>();
  for (const e of ctx.events) {
    const d = localDay(new Date(e.startsAt).getTime(), ctx.utcOffsetMinutes);
    totals.set(d, (totals.get(d) ?? 0) + minutesOf(e));
  }
  const [day, minutes] = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return `${dayLabel(day)} is your busiest day with ${hm(minutes)} scheduled.`;
}

export function focusBlocks(ctx: AssistContext): string {
  const blocks = ctx.events.filter((e) => e.taskId);
  if (blocks.length === 0) return "No focus blocks yet. Use Block time on a task to add one.";
  const lines = blocks
    .slice(0, 8)
    .map((e) => `${timeLabel(new Date(e.startsAt), ctx.utcOffsetMinutes)}: ${e.title} (${hm(minutesOf(e))})`);
  return `${blocks.length} focus block${blocks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

export function meetingCount(ctx: AssistContext): string {
  const meetings = ctx.events.filter((e) => !e.taskId);
  if (meetings.length === 0) return "No meetings or standalone events this week.";
  const total = meetings.reduce((sum, e) => sum + minutesOf(e), 0);
  return `${meetings.length} event${meetings.length === 1 ? "" : "s"} that aren't task blocks, ${hm(total)} in total.`;
}

export function findSlots(ctx: AssistContext, minutes: number): string {
  const busy: Interval[] = ctx.events.map((e) => ({ start: new Date(e.startsAt), end: new Date(e.endsAt) }));
  const found: Interval[] = [];
  let from = ctx.now;
  for (let i = 0; i < 3; i += 1) {
    const slot = findFreeSlot({ from, minutes, busy: [...busy, ...found], utcOffsetMinutes: ctx.utcOffsetMinutes, bufferMinutes: 10 });
    if (!slot) break;
    found.push(slot);
    from = slot.end;
  }
  if (found.length === 0) return `No ${hm(minutes)} slot fits in your working hours in the next two weeks.`;
  return `Free ${hm(minutes)} slots:\n${found.map((s) => timeLabel(s.start, ctx.utcOffsetMinutes)).join("\n")}`;
}

export function answer(prompt: string, ctx: AssistContext): string {
  const p = prompt.toLowerCase();
  const hours = p.match(/(\d+(?:\.\d+)?)\s*-?\s*(hour|hr|h)\b/);
  const mins = p.match(/(\d+)\s*-?\s*(minute|min|m)\b/);
  if (/(free|slot|find time|open time|deep work|available)/.test(p)) {
    const minutes = hours ? Math.round(Number(hours[1]) * 60) : mins ? Number(mins[1]) : 60;
    return findSlots(ctx, Math.min(Math.max(minutes, 15), 480));
  }
  if (/busiest|busy|heaviest|packed/.test(p)) return busiestDay(ctx);
  if (/focus|block/.test(p)) return focusBlocks(ctx);
  if (/meeting|event|how many/.test(p)) return meetingCount(ctx);
  return "I can answer: busiest day, focus blocks, free slots (say how long, like 2 hours), and how many meetings you have.";
}

export const SUGGESTED_PROMPTS = [
  "What's my busiest day this week?",
  "Show my focus blocks",
  "Find 2-hour slots for deep work",
  "How many meetings do I have?",
] as const;
