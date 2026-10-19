"use server";

import { revalidatePath } from "next/cache";
import { claimShard, createRewardDefinition } from "@/domains/gamification/commands";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Definitions are catalog rows, not earning rules: creating one changes no
 * balances and awards nothing. The rules that call awardReward wait on the
 * owner's ASH-135 section 7 decisions.
 */

type Result = { ok: true } | { ok: false; error: string };

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
