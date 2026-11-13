import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { FOUNDRY_CAPABILITY, proposeStone } from "../../../../src/domains/gamification/proposals";
import { stoneRecipeSchema } from "../../../../src/domains/gamification/recipe";
import { runSessionRef } from "../lib/run-session";

/*
 * Turns a designed stone into a reviewable foundry proposal. The agent tool
 * surface is read-only on purpose, the same way tasks_propose is: nothing
 * lands in the collection until the owner approves the recipe in the review
 * queue (rewards page or run_reviews), and a resumed step or a retry
 * re-derives the same dedupe key and resolves the existing proposal instead
 * of queuing a second one. The recipe schema is the shared one - malformed
 * designs are refused here, before anything is proposed. The run's frozen
 * policy must allow stones.foundry.create.
 */
export default defineTool({
  description:
    "Propose an ML-designed stone recipe for the owner to review. Call when the run has designed a stone worth adding to the collection - a name, rarity, theme, palette, and SVG on a 200x200 canvas. Do not propose stones the collection already covers. Nothing is created until the owner approves it; the approval writes the stone's definition into the gen- namespace. Pass a stable dedupeId so a retry resolves the same proposal.",
  inputSchema: stoneRecipeSchema.extend({
    dedupeId: z
      .string()
      .min(1)
      .max(200)
      .describe("Stable identifier for this design (e.g. the run step that produced it), so a retry proposes once."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(runSessionRef(ctx.session), workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, FOUNDRY_CAPABILITY)) {
      return { ok: false as const, error: `${FOUNDRY_CAPABILITY} is not in this run's policy snapshot` };
    }
    const { dedupeId, ...recipe } = input;
    const result = await proposeStone(
      { userId: current.principalId, workspaceId },
      { ...recipe, dedupeId, runId: run.id },
    );
    return {
      ok: true as const,
      proposalId: result.proposalId,
      deduplicated: result.deduplicated,
      status: "awaiting review",
    };
  },
});
