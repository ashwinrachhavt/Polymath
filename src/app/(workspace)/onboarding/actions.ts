"use server";

import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import {
  completeOnboarding,
  markOnboardingWelcomed,
  readOnboardingModelPolicy,
  readOnboardingRun,
  refineOnboardingDraft,
  saveOnboardingProgress,
  startOnboardingRun,
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
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { interviewModelGate } from "./model-gate";

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
    const message = cause instanceof Error && cause.message ? cause.message : "Onboarding could not be saved.";
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
    // The credential gate runs before any row exists (QA F7). The eve runtime
    // resolves the profile's model on its first turn, so a missing provider
    // key used to surface only there — run created, profile made, reservation
    // held, interview dead mid-conversation. Gating on the profile's resolved
    // model here turns that into a labelled start failure whose card carries
    // the form fallback. The policy read lives in the domain (readOnboarding
    // ModelPolicy); the action never touches db/schema directly.
    const gate = interviewModelGate(await readOnboardingModelPolicy(auth.workspaceId));
    if (!gate.ok) return { ok: false, message: gate.message };

    const { runId } = await startOnboardingRun(auth);
    return { ok: true, runId };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The interview could not start.",
    };
  }
}

export type OnboardingBriefResult = { ok: true; brief: OnboardingBrief; profileVersion: number | null } | { ok: false };

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
export async function confirmOnboardingBriefAction(input: { brief: OnboardingBrief; profileVersion: number | null }) {
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
