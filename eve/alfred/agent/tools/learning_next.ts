import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  LEARNING_REVIEW_CAPABILITY,
  nextReview,
} from "../../../../src/domains/teaching/review-session";

/*
 * Read capability: the next due cards in a deck, without their answers.
 *
 * A teaching session asks the learner first. Handing the model the answer while
 * it is supposed to be quizzing someone would defeat the exercise, so the card
 * carries the prompt, the options and the source passage, never answer or
 * explanation. Grading is a separate, write-capability tool.
 */
export default defineTool({
  description:
    "Read the next due cards for a learning deck, without their answers. Returns each card's prompt, options and the source passage it tests, so you can ask the learner and teach from the source. Read-only; the run's frozen policy must allow learning.review.",
  inputSchema: z.object({
    deckId: z.string().uuid().optional().describe("Limit to one deck. Omit for the whole workspace."),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, LEARNING_REVIEW_CAPABILITY)) {
      return { ok: false as const, error: "learning.review is not in this run's policy snapshot" };
    }
    // Reading needs only the workspace; the role is the lowest that can read.
    const auth = { userId: current.principalId, workspaceId, role: "viewer" as const };
    const { cards, total } = await nextReview(auth, { deckId: input.deckId, limit: input.limit });
    return { ok: true as const, total, cards };
  },
});
