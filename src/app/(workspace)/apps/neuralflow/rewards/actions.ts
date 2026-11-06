"use server";

import { revalidatePath } from "next/cache";
import { claimShard, createRewardDefinition } from "@/domains/gamification/commands";
import { getAuthContext } from "@/lib/auth";
import type { Result } from "@/lib/result";
import { requireRole } from "@/lib/auth/guards";
import { decideProposalAction } from "@/app/(workspace)/reviews/actions";

/*
 * Definitions are catalog rows, not earning rules: creating one changes no
 * balances and awards nothing. The rules that call awardReward wait on the
 * owner's ASH-135 section 7 decisions.
 */

export async function createDefinitionAction(input: {
  key: string;
  kind: "points" | "streak_day" | "badge" | "collectible";
  label: string;
  description: string;
  points: number;
}): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!input.key.trim() || !input.label.trim()) {
    return { ok: false, error: "A key and a label are required." };
  }
  try {
    await createRewardDefinition(auth, {
      key: input.key.trim(),
      kind: input.kind,
      label: input.label.trim(),
      description: input.description.trim() || null,
      points: Number.isFinite(input.points) ? input.points : 0,
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Could not save the reward definition." };
  }
  revalidatePath("/apps/neuralflow/rewards");
  return { ok: true };
}

/* Five stones, one shard - claimed by hand, never auto-converted (A10). */
export async function claimShardAction(): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await claimShard(auth);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The shard could not be claimed." };
  }
  revalidatePath("/apps/neuralflow/rewards");
  return { ok: true };
}

/*
 * A foundry stone decision (spec §7): the canonical Reviews decide action is
 * the one path - it records the decision, and for an approval dispatches
 * through LOCAL_WRITERS to apply the recipe. This wrapper only adds this
 * page's revalidation, so the Foundry section and the collection refresh
 * together; the decision semantics (CAS, idempotency, replay) stay in one
 * place, the same queue every other proposal decides through.
 */
export async function decideFoundryProposalAction(input: {
  proposalId: string;
  expectedVersion: number;
  revisionId: string;
  idempotencyKey: string;
  decision: "approved" | "rejected";
}): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const result = await decideProposalAction(input);
  revalidatePath("/apps/neuralflow/rewards");
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}
