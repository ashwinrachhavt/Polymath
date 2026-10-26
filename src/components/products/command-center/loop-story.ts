import type { WorkspaceState } from "@/components/workspace/types";
import type { AppSlug } from "@/lib/navigation";

export type Beat = { key: string; label: string; app: AppSlug; count: number; unit: string; reason: string; href: string; action: string; needsYou: boolean };

export function loopBeats(state: WorkspaceState, today: string): Beat[] {
  const unprocessed = state.captures.filter((capture) => capture.status === "UNPROCESSED").length;
  const capturedToday = state.captures.filter((capture) => capture.createdAt.slice(0, 10) === today).length;
  const open = state.tasks.filter((task) => task.status !== "DONE");
  const outcomes = open.filter((task) => task.tags.includes(`Outcome:${today}`)).length;
  const ready = open.filter((task) => task.status === "READY" || task.status === "IN_PROGRESS").length;
  const pending = state.reviews.filter((review) => review.status === "Pending").length;
  const notes = state.artifacts.filter((artifact) => artifact.kind === "note" || artifact.kind === "zettel").length;
  const focus = state.focus;
  const focusTask = focus ? state.tasks.find((task) => task.id === focus.taskId) : undefined;

  return [
    { key: "capture", label: "Capture", app: "command-center", count: capturedToday, unit: capturedToday === 1 ? "item today" : "items today",
      reason: "Anything that arrives lands in one inbox, original kept.", href: "/command-center/inbox", action: "Open inbox", needsYou: false },
    { key: "clarify", label: "Clarify", app: "command-center", count: unprocessed, unit: "to clarify",
      reason: unprocessed ? "Turn each into a task, a note, or let it go." : "Nothing is waiting. Your inbox is clear.", href: "/command-center/inbox", action: unprocessed ? "Clarify now" : "View inbox", needsYou: unprocessed > 0 },
    { key: "commit", label: "Commit", app: "command-center", count: outcomes, unit: "of 3 outcomes",
      reason: outcomes >= 3 ? "Today is decided. Protect it." : `${open.length} open commitments. Choose up to three that matter today.`, href: "/neuralflow/work?view=today", action: outcomes >= 3 ? "See outcomes" : "Choose outcomes", needsYou: outcomes < 3 && open.length > 0 },
    { key: "focus", label: "Focus", app: "neuralflow", count: focus ? 1 : ready, unit: focus ? `session ${focus.status}` : "ready to work",
      reason: focus ? `Return to ${focusTask?.title ?? "your session"}.` : ready ? "Pick one, start an interval, earn a stone." : "Move a task to Ready when you choose to work on it.",
      href: "/neuralflow/work?view=today", action: focus ? "Return to session" : "Start focus", needsYou: !!focus || ready > 0 },
    { key: "review", label: "Review", app: "command-center", count: pending, unit: "awaiting you",
      reason: pending ? "Nothing leaves Polymath until you approve the exact revision." : "No proposals are waiting for a decision.", href: "/reviews", action: pending ? "Review proposals" : "Open reviews", needsYou: pending > 0 },
    { key: "learn", label: "Learn", app: "alfred", count: state.rewards.length, unit: state.rewards.length === 1 ? "stone earned" : "stones earned",
      reason: `${notes} notes and ideas you can think with. Stones remember the work that earned them.`, href: "/apps/neuralflow/rewards", action: "See your stones", needsYou: false },
  ];
}

export function nextBeat(beats: Beat[]) {
  return beats.find((beat) => beat.needsYou)?.key;
}
