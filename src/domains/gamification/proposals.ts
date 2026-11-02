import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { foundryKeyForRecipeName, stoneRecipeSchema, type StoneRecipe, type StoneRecipeInput } from "./recipe";
import { rewardDefinitions } from "./schema";

/*
 * Agent-proposed foundry stones (spec §7). A run that has designed a stone
 * cannot add it to the collection itself: the recipe lands here as a
 * proposal in the owner's review queue, and only the owner's approval
 * writes the definition - parsed one more time at that boundary, because
 * the owner may revise the payload as free JSON between proposal and
 * decision. The approval is replay-safe twice over: the decision through
 * its idempotency receipt, the write through the definitions' unique
 * (workspace, key) pair in the `gen-` namespace.
 */

/** The review-gated capability a stone proposal is made and approved under. */
export const FOUNDRY_CAPABILITY = "stones.foundry.create";

export type StoneProposalPayload = StoneRecipe;

/**
 * Agent / generator entry point. `dedupeId` is the proposer's own intent
 * key; replays resolve the same proposal instead of queuing a second one.
 * The recipe is parsed first, so a malformed design never becomes a
 * proposal the owner has to reject by hand.
 */
export async function proposeStone(
  auth: Pick<AuthContext, "workspaceId"> & { userId?: string | null },
  input: StoneRecipeInput & { dedupeId: string; runId?: string | null },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const recipe = stoneRecipeSchema.parse({
    name: input.name,
    rarity: input.rarity,
    theme: input.theme,
    palette: input.palette,
    svg: input.svg,
  });
  return withTransaction(async (tx) => {
    const result = await createProposal(tx, auth, {
      capability: FOUNDRY_CAPABILITY,
      riskClass: "prepare",
      targetType: "reward_definition",
      title: `Forge stone: ${recipe.name}`,
      expectedEffect: `Adds the foundry stone "${recipe.name}" (${recipe.rarity}) to the collection once approved.`,
      dedupeKey: `stones:${input.runId ?? "foundry"}:${input.dedupeId}`,
      runId: input.runId ?? null,
    });
    if (!result.deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: result.proposalId,
        revisionNumber: 1,
        payload: recipe,
        preview: { name: recipe.name, theme: recipe.theme, rarity: recipe.rarity, palette: recipe.palette },
        createdBy: auth.userId ?? null,
      });
    }
    return result;
  });
}

/**
 * One-tap approve: records the decision, then applies the approved recipe.
 * A retry after the decision committed falls through to the replay-safe
 * write, the way approveTaskProposal does.
 */
export async function approveStoneProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<{ definitionId: string; key: string; deduplicated: boolean }> {
  try {
    await decideProposal(auth, {
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      decision: "approved",
      idempotencyKey: `stones-decide:${input.proposalId}`,
    });
  } catch (error) {
    if (!(error instanceof ProposalConflictError)) throw error;
    const [proposal] = await db
      .select({ status: actionProposals.status })
      .from(actionProposals)
      .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (proposal?.status !== "approved") throw error;
  }

  const [revision] = await db
    .select({ payload: actionRevisions.payload })
    .from(actionRevisions)
    .where(and(eq(actionRevisions.id, input.revisionId), eq(actionRevisions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!revision) throw new Error("The approved stone revision could not be found.");

  // The owner may revise the payload as free JSON, so execute re-validates.
  const recipe = stoneRecipeSchema.parse(revision.payload);
  const key = foundryKeyForRecipeName(recipe.name);

  return withTransaction(async (tx) => {
    const [definition] = await tx
      .insert(rewardDefinitions)
      .values({
        workspaceId: auth.workspaceId,
        key,
        kind: "collectible",
        label: recipe.name,
        description: recipe.theme,
        points: 0,
        recipe,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [rewardDefinitions.workspaceId, rewardDefinitions.key] })
      .returning();
    if (definition) {
      await recordAudit(
        auth,
        {
          action: "reward_definition.created",
          subjectType: "reward_definition",
          subjectId: definition.id,
          summary: `Foundry stone approved: ${definition.key}`,
        },
        tx,
      );
      return { definitionId: definition.id, key, deduplicated: false };
    }
    // A racy duplicate approval: the unique (workspace, key) pair picked the
    // first writer; resolve its row instead of erroring.
    const [existing] = await tx
      .select({ id: rewardDefinitions.id })
      .from(rewardDefinitions)
      .where(and(eq(rewardDefinitions.workspaceId, auth.workspaceId), eq(rewardDefinitions.key, key)))
      .limit(1);
    if (!existing) throw new Error("The foundry definition vanished during dedupe resolve.");
    return { definitionId: existing.id, key, deduplicated: true };
  });
}
