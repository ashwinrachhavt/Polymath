import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { installEvalGuard } from "./harness";
import { assertEvalEnvironment, quietStubs } from "./stubs";

// Before a turn starts: a provider credential in the environment turns a missed
// stub into a real call, so a misconfigured eval must fail here, not pass.
assertEvalEnvironment();

/*
 * Desirable outputs, synthesis pattern: a progress question ("what is on my
 * plate today") is answered by composing from the reads that hold data —
 * finished work from `tasks_recent`, remaining work from `tasks_read` — and the
 * reply never opens with a gap it could have named later. This is the
 * behavioral half of `instructions.md`'s compose-then-name-the-gap rule: the
 * done-list must be real (actual completed titles appear) and the deadline
 * layer must surface (the today-due titles appear), not a generic "you have
 * tasks" summary.
 *
 * The stub rows mirror what the real tools return (listOpenTasks /
 * listRecentlyCompletedTasks: id, title, status, priority, dueAt/completedAt),
 * with dates as ISO strings — `tasks_recent.ts` serializes `completedAt` to ISO
 * across eve's tool boundary. The model sees only stub data, so the stub's
 * literal date strings are "today" and "earlier today" by construction; nothing
 * is computed at runtime.
 */
const COMPLETED_TASKS = [
  {
    id: "00000000-0000-0000-0000-00000000c001",
    title: "Ship invoice PDF export",
    status: "done",
    priority: "high",
    completedAt: "2026-10-29T08:30:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-00000000c002",
    title: "Migrate billing webhooks to v2",
    status: "done",
    priority: "medium",
    completedAt: "2026-10-29T07:00:00.000Z",
  },
];

// Exactly two of the five open tasks are due today (2026-10-29); the rest are
// undated or future, so the deadline layer is a real selection, not the whole
// board.
const OPEN_TASKS = [
  {
    id: "00000000-0000-0000-0000-00000000o001",
    title: "Review Q4 vendor contract",
    status: "in_progress",
    priority: "high",
    dueAt: "2026-10-29T17:00:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-00000000o002",
    title: "Prepare board update deck",
    status: "ready",
    priority: "urgent",
    dueAt: "2026-10-29T23:00:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-00000000o003",
    title: "Draft onboarding email sequence",
    status: "inbox",
    priority: "low",
    dueAt: null,
  },
  {
    id: "00000000-0000-0000-0000-00000000o004",
    title: "Archive stale wiki pages",
    status: "backlog",
    priority: "none",
    dueAt: "2026-11-06T12:00:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-00000000o005",
    title: "Book team offsite venue",
    status: "waiting",
    priority: "medium",
    dueAt: null,
  },
];

/*
 * `instructions.md` forbids opening with a missing-records statement when the
 * reads returned usable data ("no calendar is connected" / "I cannot see
 * meetings" as the first words). The gap may still be named — just not led
 * with. eve's turn exposes `message` as one string with no sentence accessor,
 * so the opener is derived here: the first non-empty line, cut at the first
 * sentence terminator. Lines matter because replies are markdown — a bulleted
 * answer can run to the gap line without ever producing a `.`, and a plain
 * character split would then convict a reply that named the gap last, which
 * the rule allows. A reply that opens "I cannot see your meetings..." still
 * fails; one that opens "Here is your plate..." and mentions the gap in a
 * later line passes.
 */
const MISSING_RECORDS_OPENER = /no (calendar|meetings)|cannot see/i;

function firstSentence(message: string | undefined): string {
  const firstLine =
    (message ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.split(/[.!?]/)[0] ?? "";
}

export const whatIsOnMyPlateToday = defineEval({
  description:
    "A what-is-on-my-plate question composes the answer from completed work and open work, surfaces today's deadlines, and never opens with a missing-records statement.",
  tags: ["desirable-outputs"],
  async test(t) {
    const restore = installEvalGuard(t.target, "desirable-outputs/whatIsOnMyPlateToday");
    try {
      const session = await t.session({
        stubs: [
          {
            id: "tasks-recent-completed",
            tool: "tasks_recent",
            outcome: { response: { ok: true, tasks: COMPLETED_TASKS, days: 7 } },
          },
          {
            id: "tasks-read-open",
            tool: "tasks_read",
            outcome: { response: { ok: true, tasks: OPEN_TASKS, limit: 25 } },
          },
          // calendar_conflicts stays on its quiet stub (empty calendar): the
          // point is that a reply holding task data does not lead with the gap.
          ...quietStubs(),
        ],
      });

      const turn = await session.send("What is on my plate today?");
      turn.expectOk();

      // Progress is sourced from completed work, not inferred.
      turn.calledTool("tasks_recent");
      // Remaining work comes from the open-task read.
      turn.calledTool("tasks_read");

      // The done-list is real: actual completed titles appear.
      for (const done of COMPLETED_TASKS) {
        t.check(turn.message, includes(done.title)).label(`completed work surfaces: ${done.title}`);
      }
      // The deadline layer surfaces: the today-due open titles appear.
      for (const due of OPEN_TASKS.filter((task) => task.dueAt?.startsWith("2026-10-29"))) {
        t.check(turn.message, includes(due.title)).label(`today-due work surfaces: ${due.title}`);
      }

      // The gap may be named, but never opened with.
      t.check(
        firstSentence(turn.message),
        satisfies((s: unknown) => !MISSING_RECORDS_OPENER.test(String(s)), "opens with found data, not a gap"),
      ).label("first sentence does not open with missing records");
      t.succeeded();
    } finally {
      restore();
    }
  },
});

const cases = [whatIsOnMyPlateToday];
export default cases;
