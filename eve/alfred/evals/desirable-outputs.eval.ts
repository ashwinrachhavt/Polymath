import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { installEvalGuard } from "./harness";
import { assertEvalEnvironment, quietStubs } from "./stubs";

/*
 * Desirable outputs, proposal pattern: material the owner pastes reaches the
 * proposal tool unsummarized, and the reply frames a draft waiting for review
 * rather than a thing done.
 *
 * This is the behavioral half of the propose tools (ASH-285 here). The
 * transport-side contract — the tool can only ever draft, never create — is
 * pinned by the tool and its tests; what only a real turn can show is whether
 * the agent passes the paste through verbatim instead of compressing it (the
 * details a summary drops are exactly the details acceptance criteria need)
 * and whether it reports a draft rather than claiming a Linear issue exists.
 *
 * Tools are stubbed, so the model runs live but Linear is never reached. The
 * specific stub sits before `...quietStubs()` because playback picks the first
 * matching rule, and its title differs from the quiet stub's so a reply that
 * relays it proves which rule answered.
 *
 * Tagged `desirable-outputs` and requires a model credential; see the README
 * in this directory for which suite to run against a live agent.
 */

// Before a turn starts: a provider credential in the environment turns a missed
// stub into a real call, so a misconfigured eval must fail here, not pass.
assertEvalEnvironment();

/*
 * The paste. The distinctive phrases are strings a summarizer plausibly drops —
 * an exact numeral with its cause, and an odd proper noun with a bare date near
 * the tail — which is the point: a draft built from a summary loses these.
 */
const PASTED_REPORT = [
  "Pasting a bug report from QA notes — please turn this into a Linear issue:",
  "",
  '"The inbox badge shows 3 unread after I archived everything — the count is not '
    + "decrementing on archive. Reproduced on iOS 26.1 and desktop; web is fine. "
    + "Steps: open the inbox, archive all five threads, return to the home screen. "
    + "The badge keeps its stale total until the app is force-quit. A second observer "
    + "saw the same thing on her account, so it is not tied to one workspace member. "
    + "The stale count also survives a background refresh, but a manual pull-to-refresh "
    + "clears it. Started after the Vantablack sync migration shipped on the 14th; the "
    + 'badge used to clear within a second before that release. Console shows a repeated '
    + '"badge delta ignored" warning each time an archive lands."',
].join("\n");

// Early in the paste, and the single most summary-vulnerable sentence in it.
const DISTINCTIVE_PHRASE =
  "The inbox badge shows 3 unread after I archived everything — the count is not decrementing on archive";

// Late in the paste: a summarizer keeps the symptom and drops the odd noun and date.
const LATE_PHRASE = "Started after the Vantablack sync migration shipped on the 14th";

/*
 * Only an asserted filing is a violation. Correct no-claim phrasings contain
 * "filed" ("nothing has been filed yet", "it won't be filed until you
 * approve"), so a bare `filed` alternative false-positives on exactly the
 * replies this assertion wants to reward; the verb must take an object
 * ("filed it / the / a ...") before it counts as a claim of creation.
 */
const CREATION_CLAIM =
  /created (an|the) issue|filed (it|this|a|the|an|to)|submitted to Linear/i;

export const linearDraftFromPastedMaterial = defineEval({
  description:
    "A Linear issue drafted from pasted material carries the paste verbatim and is framed as a draft awaiting review, never as a created issue.",
  tags: ["desirable-outputs"],
  async test(t) {
    // Installed per test, not at import: the runner's own loopback traffic to
    // the agent under test has to keep working, and the guard is restored in
    // `finally` so one eval cannot leave the process guarded for the next.
    const restore = installEvalGuard(t.target, "desirable-outputs/linearDraftFromPastedMaterial");
    try {
      const session = await t.session({
        stubs: [
          {
            id: "linear-draft",
            tool: "linear_issue_propose",
            // The drafted shape from stubs.ts, with a title that proves this
            // rule (not the quiet stub) answered when the reply relays it.
            outcome: {
              response: {
                ok: true,
                status: "drafted",
                artifactId: "00000000-0000-0000-0000-000000000000",
                title: "Linear issue draft: eval paste stub",
                generated: false,
                outcome: "created",
              },
            },
          },
          ...quietStubs(),
        ],
      });

      const turn = await session.send(PASTED_REPORT);
      turn.expectOk();

      // The proposal path is taken, not a wiki note or a chat answer.
      turn.calledTool("linear_issue_propose");

      // The tool's captured input must carry the paste as the owner gave it.
      // "contains" rather than "equals": the model may wrap the paste in its
      // own framing, and pinning the full input made the eval measure phrasing
      // instead of fidelity.
      const call = turn.toolCalls.find((c) => c.name === "linear_issue_propose");
      const text = call?.input?.text;
      t.check(text, includes(DISTINCTIVE_PHRASE)).label("the distinctive phrase reached the tool verbatim");
      // And the tail survives too: a summary keeps the headline symptom and
      // drops the closing details.
      t.check(text, includes(LATE_PHRASE)).label("the tail of the paste is not dropped");

      // The reply frames a draft waiting for the owner, in any phrasing.
      t.check(turn.message, includes(/proposal|draft|review/i)).label("framed as a draft awaiting review");
      // And never claims a Linear issue exists. A property check, not a
      // phrase list: the failure is the claim of creation, not one wording.
      t.check(turn.message, satisfies((m: unknown) => !CREATION_CLAIM.test(String(m)), "no claim of creation"))
        .label("does not claim a Linear issue was created");
      t.succeeded();
    } finally {
      restore();
    }
  },
});

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
  const firstLine = (message ?? "")
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

const cases = [linearDraftFromPastedMaterial, whatIsOnMyPlateToday];
export default cases;
