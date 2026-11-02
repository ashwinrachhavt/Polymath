/**
 * The decision record every Assessment carries: the Eve judgment, the Mercury
 * Decide probability, and the final decision with the path that decided it
 * (spec §9). Pure data and one pure rule — the assessor implementation (the
 * `Assessor` port's host-side module) produces these and writes the record into
 * the Decision's `audit`, so the Engine never sees Decide and stays
 * deterministic.
 */
import type { DecisionKind } from "../core/model";

/** What Eve's own assessment concluded through the orchestrator_eval tools, as the assessor recorded it. */
export interface EveJudgment {
  /** The assessment outcome Eve reached; it maps onto the Decision kinds an assessment can end with. */
  outcome: "accept" | "ignore" | "unavailable" | "stop";
  /** Rule ids the assessment matched, when it accepted. */
  rules?: string[];
  /** Why, in the assessor's words. */
  reason?: string;
}

/** Mercury Decide's calibrated verdict on the admission question. */
export interface DecideVerdict {
  /** Probability (0-1) that the candidate should be admitted, from the binary-probability (noul) question. */
  admitProbability: number;
  /** The question the probability answers, for audit. */
  question: string;
  /** The model that answered, as the response named it. */
  model: string;
}

/** Which path produced the final decision: Eve's judgment, or the escalation rule when the two judgments parted. */
type DecisionPath = "eve" | "escalated";

/** Why the escalation rule decided: the probability fell below the admit threshold on an Eve acceptance, or the two judgments disagreed about admission. */
type EscalationCause = "belowThreshold" | "disagreement";

export interface AssessmentDecisionRecord {
  eve: EveJudgment;
  /** The Decide verdict, or null when Decide could not run — the record shows the absence rather than inventing a probability. */
  decide: DecideVerdict | null;
  final: {
    kind: DecisionKind;
    decidedBy: DecisionPath;
    /** Set only when the escalation rule decided. */
    escalation?: EscalationCause;
  };
}

/** The escalation rule: admission requires Eve's acceptance and a Decide probability at or above the threshold. */
export interface DecideEscalation {
  admitThreshold: number;
}

/**
 * Combine the two judgments into the final decision.
 *
 * - Eve unavailable: no judgment to combine, and Decide alone cannot admit —
 *   the decision is unavailable.
 * - Eve stop: a stop ends existing work; the admission question does not bear
 *   on it, so the stop stands whatever the probability said.
 * - Eve accepted but the probability fell below the threshold: escalate as
 *   `belowThreshold` — not-admitted is recorded and the panel surfaces it.
 * - Eve would not admit but the probability reached the threshold: escalate as
 *   `disagreement` — likewise not-admitted, never admitted over Eve.
 * - Decide absent (an error, an unconfigured key): Eve decides, and the
 *   record's `decide: null` shows the seam did not run. The pipeline must not
 *   hard-stop because a second provider is down.
 */
export function resolveAssessmentDecision(
  eve: EveJudgment,
  decide: DecideVerdict | null,
  escalation: DecideEscalation,
): AssessmentDecisionRecord {
  if (eve.outcome === "unavailable") return { eve, decide, final: { kind: "unavailable", decidedBy: "eve" } };
  if (eve.outcome === "stop") return { eve, decide, final: { kind: "stop", decidedBy: "eve" } };
  if (decide) {
    const admits = decide.admitProbability >= escalation.admitThreshold;
    if (eve.outcome === "accept" && !admits)
      return { eve, decide, final: { kind: "ignore", decidedBy: "escalated", escalation: "belowThreshold" } };
    if (eve.outcome === "ignore" && admits)
      return { eve, decide, final: { kind: "ignore", decidedBy: "escalated", escalation: "disagreement" } };
  }
  return { eve, decide, final: { kind: eve.outcome, decidedBy: "eve" } };
}
