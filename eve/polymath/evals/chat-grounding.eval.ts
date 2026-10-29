import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { installEvalGuard } from "./harness";
import { assertEvalEnvironment, quietStubs } from "./stubs";

/*
 * Chat grounding: the agent answers from the owner's documents, cites what it
 * used, and does not fabricate when nothing matches.
 *
 * This is the behavioral half of the chat feature. The transport (framing,
 * reconnect, deltas) is pinned by tests/unit/stream-contract.test.ts; what only
 * a real turn can show is whether the agent actually reaches for the corpus
 * before answering and whether it says "no match" instead of improvising.
 *
 * Tools are stubbed, so the model runs live but the corpus read is deterministic.
 * That keeps the eval about the agent's behavior rather than about embeddings.
 *
 * Tagged `chat` and requires a model credential; see evals/README in this
 * directory for which suite to run against a live agent.
 */

/*
 * An eval must not touch anything real. Only stubbing documents_search left
 * every other tool live, and a run that also reached for connected_read read the
 * owner's actual inbox — an eval that hits production data is not a test, it is
 * an incident waiting for the wrong credential. `quietStubs()` now comes from
 * stubs.ts, so the list every tool the agent can choose is covered by one shared
 * declaration rather than a copy in each eval; the coverage test keeps it honest.
 */

// Before a turn starts: a provider credential in the environment turns a missed
// stub into a real call, so a misconfigured eval must fail here, not pass.
assertEvalEnvironment();

const groundedAnswer = defineEval({
  description: "A grounded chat answer cites the document it came from instead of asserting a fact.",
  tags: ["chat"],
  async test(t) {
    // Installed per test, not at import: the runner's own loopback traffic to
    // the agent under test has to keep working, and the guard is restored in
    // `finally` so one eval cannot leave the process guarded for the next.
    const restore = installEvalGuard(t.target, "chat-grounding/groundedAnswer");
    try {
      const session = await t.session({
        stubs: [
          {
            id: "lease",
            tool: "documents_search",
            outcome: {
              response: {
                ok: true,
                query: "rent",
                results: [
                  {
                    documentId: "doc-lease",
                    title: "Apartment lease 2026",
                    text: "Monthly rent is 2,400 and is due on the first of each month.",
                    span: { start: 120, end: 184, page: 2 },
                  },
                ],
              },
            },
          },
          ...quietStubs(),
        ],
      });

      const turn = await session.send("How much is my rent and when is it due?");
      turn.expectOk();

      // The agent must consult the corpus before answering a question about it.
      // "at least one" rather than "exactly one": a model that rewords its query
      // and searches twice is doing the right thing, and pinning the count made
      // this eval fail about half the time for behavior that was correct.
      turn.calledTool("documents_search");
      // And it must name the source, not just restate the value.
      turn.messageIncludes("lease");
      t.check(turn.message, includes("2,400")).label("the amount comes from the passage");
      t.succeeded();
    } finally {
      restore();
    }
  },
});

export const noMatch = defineEval({
  description: "With no matching document, the agent says so rather than inventing an answer.",
  tags: ["chat"],
  async test(t) {
    const restore = installEvalGuard(t.target, "chat-grounding/noMatch");
    try {
      const session = await t.session({
        stubs: [
          {
            id: "empty",
            tool: "documents_search",
            outcome: { response: { ok: true, query: "car insurance", results: [] } },
          },
          ...quietStubs(),
        ],
      });

      const turn = await session.send("What does my car insurance policy cover?");
      turn.expectOk();
      turn.calledTool("documents_search");
      // Stating an absence is the correct answer; a confident policy summary
      // built from nothing is the failure this eval exists to catch. The matcher
      // is a property, not one phrasing: a real run answered "I was unable to
      // find any ...", which a narrower word list rejected as a failure.
      t.check(
        turn.message,
        includes(/no |not |unable|couldn'?t|cannot|nothing|didn'?t find|no match/i),
      ).label("states that nothing was found");
      t.succeeded();
    } finally {
      restore();
    }
  },
});

const cases = [groundedAnswer, noMatch];
export default cases;
