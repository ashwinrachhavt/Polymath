"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { ensureProfile } from "@/domains/agents/commands";
import { agentProfiles } from "@/domains/agents/schema";
import { availableModels, modelById } from "@/domains/agents/models";

/*
 * Choosing the model for the next run.
 *
 * Written to the profile, not to a run: a run cannot change its model once it
 * starts (the snapshot is its contract), so the selection applies forward. That
 * is also why this is one indexed write and no receipt — the value is a
 * preference, and two concurrent writes resolve to whichever lands last, which
 * is what a preference means.
 */
export async function setModelAction(input: { modelId: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");

  // A model whose provider key is absent would freeze a run that cannot start.
  const entry = modelById(input.modelId);
  const usable = availableModels().some((model) => model.id === input.modelId);
  if (!entry || !usable) {
    return { ok: false, error: "That model is not available on this deployment." };
  }

  await ensureProfile(auth.workspaceId);
  await db
    .update(agentProfiles)
    .set({ modelPolicy: { primary: entry.id }, updatedAt: new Date(), updatedBy: auth.userId })
    .where(eq(agentProfiles.workspaceId, auth.workspaceId));

  revalidatePath("/polymath");
  return { ok: true };
}
