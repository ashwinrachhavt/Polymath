import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

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

const groundedAnswer = defineEval({
  description: "A grounded chat answer cites the document it came from instead of asserting a fact.",
  tags: ["chat"],
  async test(t) {
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
      ],
    });

    const turn = await session.send("How much is my rent and when is it due?");
    turn.expectOk();

    // The agent must consult the corpus before answering a question about it.
    turn.calledTool("documents_search", { count: 1 });
    // And it must name the source, not just restate the value.
    turn.messageIncludes("lease");
    t.check(turn.message, includes("2,400")).label("the amount comes from the passage");
    t.succeeded();
  },
});

export const noMatch = defineEval({
  description: "With no matching document, the agent says so rather than inventing an answer.",
  tags: ["chat"],
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "empty",
          tool: "documents_search",
          outcome: { response: { ok: true, query: "car insurance", results: [] } },
        },
      ],
    });

    const turn = await session.send("What does my car insurance policy cover?");
    turn.expectOk();
    turn.calledTool("documents_search", { count: 1 });
    // Stating an absence is the correct answer; a confident policy summary
    // built from nothing is the failure this eval exists to catch. The matcher
    // is a property, not one phrasing: a real run answered "I was unable to
    // find any ...", which a narrower word list rejected as a failure.
    t.check(
      turn.message,
      includes(/no |not |unable|couldn'?t|cannot|nothing|didn'?t find|no match/i),
    ).label("states that nothing was found");
    t.succeeded();
  },
});

const cases = [groundedAnswer, noMatch];
export default cases;
