"use server";

import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import {
  completeOnboarding,
  markOnboardingWelcomed,
  readOnboardingModelPolicy,
  refineOnboardingDraft,
  saveOnboardingProgress,
} from "@/domains/agents/onboarding";
import { resolveRunModel } from "@/domains/agents/models";
import {
  freeformDraftSchema,
  ONBOARDING_STEPS,
  onboardingDraftSchema,
  type FreeformDraft,
  type OnboardingDraft,
} from "@/domains/agents/onboarding-assist";
import { onboardingBriefSchema, type OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { interviewModelGate } from "./model-gate";

export type CompleteOnboardingInput = {
  agentName: string;
  role: string;
  tools: string[];
  priorities: string[];
  /**
   * The profile version the review rendered at; a mismatch means another tab
   * confirmed first, and the review re-renders with the labelled error and
   * the draft intact. The wizard's review races on this exactly like the
   * interview path's confirm card does.
   */
  expectedVersion?: number;
};

export async function completeOnboardingAction(input: CompleteOnboardingInput) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  // The person, not the client, owns the final brief: the wizard's fields
  // are untrusted at this boundary, parsed through the same schema the
  // interview's confirm card uses.
  const parsed = onboardingBriefSchema.safeParse({
    agentName: input?.agentName ?? "",
    role: input?.role ?? "",
    tools: input?.tools ?? [],
    priorities: input?.priorities ?? [],
  });
  if (!parsed.success) {
    return { ok: false as const, message: "Fill in every field: a name, what you do, your tools, and what matters." };
  }
  try {
    await completeOnboarding(auth, {
      ...parsed.data,
      ...(input?.expectedVersion != null ? { expectedVersion: input.expectedVersion } : {}),
    });
    return { ok: true as const };
  } catch (cause) {
    const message = cause instanceof Error && cause.message ? cause.message : "Onboarding could not be saved.";
    return { ok: false as const, message };
  }
}

/* ------------------------------------------------------------------------- *
 * The detached wizard's actions. The wizard asks its questions in forms, so
 * there is no run to start and nothing to poll: progress is the session row,
 * and the one assist is a single awaited structured-output call. Both reuse
 * the same domain contracts as the interview path; completeOnboarding stays
 * the only commit path for every shape of onboarding.
 * ------------------------------------------------------------------------- */

export type SaveOnboardingProgressResult = { ok: true } | { ok: false; message: string };

/**
 * Persist the wizard's position between steps (on advance, and on assist
 * success with the composed draft) so a reload mid-wizard lands on the same
 * step server-rendered. The step and draft are validated here — the client
 * input is untrusted at this boundary — and the domain trusts the types.
 */
export async function saveOnboardingProgressAction(input: {
  step: string;
  draft?: unknown;
}): Promise<SaveOnboardingProgressResult> {
  let auth;
  try {
    auth = await getAuthContext();
    requireRole(auth, "member");
  } catch {
    return { ok: false, message: "Sign in to save your progress." };
  }
  const step = ONBOARDING_STEPS.find((candidate) => candidate === input?.step);
  if (!step) return { ok: false, message: "Pick a step of the onboarding." };
  let draft: OnboardingDraft | undefined;
  if (input?.draft != null) {
    const parsedDraft = onboardingDraftSchema.safeParse(input.draft);
    if (!parsedDraft.success) {
      return { ok: false, message: "That draft has a field that does not fit — adjust it and continue." };
    }
    draft = parsedDraft.data;
  }
  try {
    await saveOnboardingProgress(auth, { step, draft });
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error && cause.message ? cause.message : "Progress could not be saved.",
    };
  }
}

export type RefineOnboardingDraftResult = { ok: true; draft: OnboardingBrief } | { ok: false; error: string };

/**
 * "Polish with Polymath" — compose the person's own words into a draft
 * brief. Gated exactly like the interview's start (the same credential gate,
 * the same profile policy, the same resolution order), but it is one awaited
 * action: no run row, no stream, no spend reservation, nothing to poll. A
 * failure returns a labelled error and the manual fields stay authoritative
 * — the assist never blocks the wizard.
 */
export async function refineOnboardingDraftAction(input: FreeformDraft): Promise<RefineOnboardingDraftResult> {
  let auth;
  try {
    auth = await getAuthContext();
    requireRole(auth, "member");
  } catch {
    return { ok: false, error: "Sign in to continue." };
  }
  const parsed = freeformDraftSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Write a little about your work first — the assist needs words to polish.",
    };
  }
  const policy = await readOnboardingModelPolicy(auth.workspaceId);
  const gate = interviewModelGate(policy);
  if (!gate.ok) return { ok: false, error: gate.message };
  const model = resolveRunModel(policy);
  if (!model) {
    return {
      ok: false,
      error:
        "No model is configured for this deployment, so the assist cannot run. Fill the fields in yourself — they carry the same weight.",
    };
  }
  try {
    const draft = await refineOnboardingDraft(auth, model, parsed.data);
    return { ok: true, draft };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error && cause.message
          ? cause.message
          : "The assist could not finish. Fill the fields in yourself — they carry the same weight.",
    };
  }
}

export type MarkOnboardingWelcomedResult = { ok: true } | { ok: false; message: string };

/**
 * Stamp the one-time welcome after the home surface has shown it. Idempotent
 * by design (the domain's where clause matches nothing on a second stamp),
 * so the home can call it from its welcome render without a guard.
 */
export async function markOnboardingWelcomedAction(): Promise<MarkOnboardingWelcomedResult> {
  let auth;
  try {
    auth = await getAuthContext();
    requireRole(auth, "member");
  } catch {
    return { ok: false, message: "Sign in to continue." };
  }
  try {
    await markOnboardingWelcomed(auth);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error && cause.message ? cause.message : "The welcome could not be marked.",
    };
  }
}
