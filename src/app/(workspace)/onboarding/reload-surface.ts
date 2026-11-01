import type { OnboardingRunReading } from "@/domains/agents/onboarding";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";

/*
 * What /onboarding renders for the most recent interview run, decided from
 * data the page already read (QA F5). The page used to fall through any run
 * without a parseable brief to a fresh <OnboardingConversation />, whose mount
 * auto-starts a run: with a failed latest run, every reload minted a new run
 * row, an eve session, and a spend reservation. The decision now names the
 * failed run explicitly instead of auto-starting past it.
 *
 * Pure by design — no database, no imports with side effects (types only) —
 * so the branch order is unit-testable.
 */

export type ReloadSurface =
  /** A finished run with a validated brief: the confirm card. */
  | { kind: "confirm"; brief: OnboardingBrief; profileVersion: number | null }
  /** The form fallback, with whatever the thread could salvage. */
  | { kind: "interview"; prefill: Partial<OnboardingBrief>; notice: string }
  /**
   * A failed run with nothing salvageable: the failure card (Retry, or the
   * form) instead of a fresh auto-start. Retry makes the next run explicit.
   */
  | { kind: "retry"; message: string }
  /** No run to recover — the island starts (or resumes) one. */
  | { kind: "conversation" };

const EXTRACTION_NOTICE =
  "We couldn't read the interview's summary cleanly. What's salvageable is pre-filled — correct it and continue.";

const FAILED_SALVAGE_NOTICE =
  "The interview could not finish. What it captured is pre-filled below — correct it and continue.";

export const RETRY_CARD_MESSAGE = "The last interview could not finish. Retry it, or answer as a form instead.";

export function resolveReloadSurface(
  latest: { state: string } | null,
  reading: Pick<OnboardingRunReading, "brief" | "prefill" | "profileVersion"> | null,
): ReloadSurface {
  if (!latest || !reading) return { kind: "conversation" };
  if (reading.brief) {
    return { kind: "confirm", brief: reading.brief, profileVersion: reading.profileVersion };
  }
  const salvage = Object.keys(reading.prefill).length > 0;
  // A failed interview run never auto-restarts: what it captured still leads
  // (as the form), and with nothing captured the failure card makes the next
  // start the person's own click.
  if (latest.state === "failed") {
    if (salvage) return { kind: "interview", prefill: reading.prefill, notice: FAILED_SALVAGE_NOTICE };
    return { kind: "retry", message: RETRY_CARD_MESSAGE };
  }
  if (salvage) return { kind: "interview", prefill: reading.prefill, notice: EXTRACTION_NOTICE };
  return { kind: "conversation" };
}
