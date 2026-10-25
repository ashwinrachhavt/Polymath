"use server";

import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { completeOnboarding, readOnboardingRun, startOnboardingRun } from "@/domains/agents/onboarding";
import { onboardingBriefSchema, type OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";

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

/*
 * The interview run's server actions. startOnboardingAction mirrors
 * startChatRun's shape (authenticate → requireRole → bridge check → engine),
 * with the run itself resume-first: a retried or double-fired start returns
 * the open interview run rather than reserving spend twice. Failures return a
 * labelled message for the status card rather than throwing into a boundary.
 */

export type StartOnboardingResult = { ok: true; runId: string } | { ok: false; message: string };

export async function startOnboardingAction(): Promise<StartOnboardingResult> {
  let auth;
  try {
    auth = await getAuthContext();
    requireRole(auth, "member");
  } catch {
    return { ok: false, message: "Sign in to start onboarding." };
  }

  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return { ok: false, message: unavailable };

  try {
    const { runId } = await startOnboardingRun(auth);
    return { ok: true, runId };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The interview could not start.",
    };
  }
}

export type OnboardingBriefResult =
  | { ok: true; brief: OnboardingBrief; profileVersion: number | null }
  | { ok: false };

/**
 * The confirm card's source of truth. The island may suspect a brief from the
 * stream, but the card is only ever rendered from this server re-read of the
 * run's persisted events — a payload held only in browser state is not a
 * brief. A run from another workspace reads as no brief.
 */
export async function onboardingBriefAction(runId: string): Promise<OnboardingBriefResult> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return { ok: false };
  let auth;
  try {
    auth = await getAuthContext();
    requireRole(auth, "member");
  } catch {
    return { ok: false };
  }
  const reading = await readOnboardingRun(auth, runId);
  if (!reading?.brief) return { ok: false };
  return { ok: true, brief: reading.brief, profileVersion: reading.profileVersion };
}

/**
 * The confirm click — the only path that stamps onboarded_at from the
 * interview. The card's edited fields are Zod-parsed server-side (the person,
 * not the model, owns the final brief) and committed through the unchanged
 * completeOnboarding, with the profile version the card rendered at so a
 * second tab's confirm loses the race instead of silently winning.
 */
export async function confirmOnboardingBriefAction(input: {
  brief: OnboardingBrief;
  profileVersion: number | null;
}) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const parsed = onboardingBriefSchema.safeParse(input.brief);
  if (!parsed.success) {
    return { ok: false as const, message: "Fill in every field: a name, what you do, your tools, and what matters." };
  }
  try {
    await completeOnboarding(auth, {
      ...parsed.data,
      ...(input.profileVersion != null ? { expectedVersion: input.profileVersion } : {}),
    });
    return { ok: true as const };
  } catch (cause) {
    const message =
      cause instanceof Error && cause.message
        ? cause.message
        : "Onboarding could not be saved.";
    return { ok: false as const, message };
  }
}
