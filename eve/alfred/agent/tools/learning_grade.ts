import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { LEARNING_REVIEW_CAPABILITY, gradeReview } from "../../../../src/domains/teaching/review-session";

/*
 * Write capability: record how the learner did on one card.
 *
 * Guarded twice on purpose. learning.review must be in the run's frozen policy,
 * and the caller supplies an idempotency key so a retried tool call does not
 * grade the card twice. The schedule is computed by the domain's SM-2 function,
 * not by the model: a model that decided its own interval would be an
 * unaccountable scheduler.
 */
export default defineTool({
  description:
    "Record the learner's result on one review card. Writes an attempt and reschedules the card. Ask the learner first and grade what they actually did, never what you hope they did. Write; the run's frozen policy must allow learning.review.",
  inputSchema: z.object({
    itemId: z.string().uuid(),
    result: z.enum(["forgot", "struggled", "recalled", "explained", "applied"]),
    /** A UUID per grade. Reuse it only when retrying the same grade. */
    idempotencyKey: z.string().uuid(),
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
    const out = await gradeReview(
      { userId: current.principalId, workspaceId, role: "member" },
      { itemId: input.itemId, result: input.result, idempotencyKey: input.idempotencyKey },
    );
    return { ok: true as const, ...out };
  },
});
