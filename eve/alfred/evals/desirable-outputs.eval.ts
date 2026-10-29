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

// A reply that claims creation, in any of its common phrasings.
const CREATION_CLAIM = /created (an|the) issue|filed|submitted to Linear/i;

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

const cases = [linearDraftFromPastedMaterial];
export default cases;
