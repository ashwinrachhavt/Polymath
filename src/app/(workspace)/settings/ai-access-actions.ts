"use server";

import { keyProviders } from "@/domains/agents/models";
import { allowanceStatus } from "@/domains/billing/ledger";
import { deleteWorkspaceKey, KeyRejectedError, listKeyStatus, saveWorkspaceKey } from "@/domains/billing/keys";
import { setProByOwner } from "@/domains/billing/plans";
import type { Plan } from "@/domains/billing/schema";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { guarded, type Result } from "@/lib/result";
import { SecretBoxUnavailableError, secretBoxAvailable } from "@/lib/secret-box";

/*
 * Settings → AI access. Keys and the plan are the owner's: a key spends their
 * money and Pro is the manual switch. Everything returned is already masked:
 * a saved key is only ever `last4`, and no action returns key text.
 */

export type AiAccessDto = {
  plan: Plan;
  used: number;
  allowance: number;
  /** ISO date the weekly allowance resets. */
  resetsAt: string;
  keys: { provider: string; label: string; last4: string }[];
  providers: { id: string; label: string }[];
  canManage: boolean;
  /** False when the deployment has no SECRETS_ENCRYPTION_KEY: keys cannot be stored. */
  canStoreKeys: boolean;
};

const keyErrors = { domainErrors: [KeyRejectedError, SecretBoxUnavailableError] };

export async function loadAiAccessAction(): Promise<Result<{ access: AiAccessDto }>> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const [status, keys] = await Promise.all([allowanceStatus(auth.workspaceId), listKeyStatus(auth.workspaceId)]);
    return {
      ok: true,
      access: {
        plan: status.plan,
        used: status.used,
        allowance: status.allowance,
        resetsAt: status.resetsAt.toISOString(),
        keys: keys.map(({ provider, label, last4 }) => ({ provider, label, last4 })),
        providers: keyProviders().map(({ id, label }) => ({ id, label })),
        canManage: auth.role === "owner",
        canStoreKeys: secretBoxAvailable(),
      },
    };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load AI access.") };
  }
}

export async function saveModelKeyAction(input: { provider: string; apiKey: string }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "owner");
  return guarded(async () => {
    await saveWorkspaceKey(auth, { provider: String(input.provider ?? ""), apiKey: String(input.apiKey ?? "") });
    return {};
  }, keyErrors);
}

export async function deleteModelKeyAction(input: { provider: string }): Promise<Result> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "owner");
    await deleteWorkspaceKey(auth, String(input.provider ?? ""));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not remove the key.") };
  }
}

export async function setProAction(input: { pro: boolean }): Promise<Result> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "owner");
    await setProByOwner(auth, input.pro === true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not change the plan.") };
  }
}
