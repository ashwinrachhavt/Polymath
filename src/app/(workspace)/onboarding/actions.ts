"use server";

import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { completeOnboarding } from "@/domains/agents/onboarding";

export type CompleteOnboardingInput = {
  agentName: string;
  role: string;
  tools: string[];
  priorities: string[];
};

export async function completeOnboardingAction(input: CompleteOnboardingInput) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await completeOnboarding(auth, input);
    return { ok: true as const };
  } catch (cause) {
    const message =
      cause instanceof Error && cause.message
        ? cause.message
        : "Onboarding could not be saved.";
    return { ok: false as const, message };
  }
}
