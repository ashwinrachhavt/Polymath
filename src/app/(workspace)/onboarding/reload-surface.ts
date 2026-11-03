import type { OnboardingRunReading } from "@/domains/agents/onboarding";
import type { OnboardingDraft, OnboardingStep } from "@/domains/agents/onboarding-assist";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";

/*
 * What /onboarding renders when the flow was interrupted, decided from data
 * the page already read. The original decision named the failed interview
 * run explicitly instead of auto-starting past it (QA F5): the page used to
 * fall through any run without a parseable brief to a fresh
 * <OnboardingConversation />, whose mount auto-starts a run — with a failed
 * latest run, every reload minted a new run row, an eve session, and a spend
 * reservation.
 *
 * The detached wizard keeps that honesty and changes the destinations: a
 * finished run's brief is the review step, and everything else — a
 * mid-wizard reload, a legacy interview run's leftovers from before the
 * deploy — lands the person on the wizard itself. Mid-wizard state rides the
 * session row (step + draft, read through readWizardState); a legacy run's
 * salvage rides prefill, its failure rides notice, so no run the old build
 * started can strand a person in a surface that no longer exists.
 *
 * Pure by design — no database, no imports with side effects (types only) —
 * so the branch order is unit-testable.
 */

export type ReloadSurface =
  /**
   * A run's validated brief: the review step, with the profile version the
   * confirm races on. Still the one commit path — completeOnboarding.
   */
  | { kind: "review"; brief: OnboardingBrief; profileVersion: number | null }
  /**
   * The wizard. A mid-wizard reload carries the session's persisted step and
   * draft; a legacy interview run's restart carries what its thread could
   * salvage as prefill and why the wizard is starting over as notice —
   * prefill goes to step one's form, not into the session draft, until the
   * person confirms they still apply.
   */
  | {
      kind: "wizard";
      step: OnboardingStep;
      draft: OnboardingDraft | null;
      prefill: Partial<OnboardingBrief>;
      notice: string | null;
    };

const EXTRACTION_NOTICE =
  "We couldn't read the interview's summary cleanly. What's salvageable is pre-filled — correct it and continue.";

const FAILED_SALVAGE_NOTICE =
  "The interview could not finish. What it captured is pre-filled below — correct it and continue.";

export const RETRY_CARD_MESSAGE = "The last interview could not finish. Retry it, or answer as a form instead.";

export function resolveReloadSurface(
  latest: { state: string } | null,
  reading: Pick<OnboardingRunReading, "brief" | "prefill" | "profileVersion"> | null,
  wizard: { step: OnboardingStep; draft: OnboardingDraft | null } | null,
): ReloadSurface {
  const wizardState = wizard ?? { step: "role" as OnboardingStep, draft: null };
  if (!latest || !reading) {
    return { kind: "wizard", ...wizardState, prefill: {}, notice: null };
  }
  // The brief beats everything, including any in-progress wizard state: a
  // finished run's composed summary is further along than a draft.
  if (reading.brief) {
    return { kind: "review", brief: reading.brief, profileVersion: reading.profileVersion };
  }
  const salvage = Object.keys(reading.prefill).length > 0;
  // A failed interview run never auto-restarts past itself: what it captured
  // leads (as prefill), and with nothing captured the notice makes the next
  // start the person's own click. F5, wizard-shaped.
  if (latest.state === "failed") {
    if (salvage) {
      return { kind: "wizard", step: "role", draft: null, prefill: reading.prefill, notice: FAILED_SALVAGE_NOTICE };
    }
    return { kind: "wizard", step: "role", draft: null, prefill: {}, notice: RETRY_CARD_MESSAGE };
  }
  if (salvage) {
    return { kind: "wizard", step: "role", draft: null, prefill: reading.prefill, notice: EXTRACTION_NOTICE };
  }
  // No brief, no failure, nothing salvageable — a live interview run resumed
  // later, or a run whose summary never parsed: where the wizard left off,
  // or a fresh wizard.
  return { kind: "wizard", ...wizardState, prefill: {}, notice: null };
}
