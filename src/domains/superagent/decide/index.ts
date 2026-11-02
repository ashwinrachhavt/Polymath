/** The Mercury Decide seam: typed wire contract, thin HTTP client, and the assessment decision record. */
export * from "./types";
export {
  DECIDE_BASE_URL,
  DECIDE_MODEL_ID,
  DecideError,
  decideClient,
  decideClientFromEnv,
  type DecideClient,
  type DecideClientConfig,
} from "./client";
export {
  resolveAssessmentDecision,
  type AssessmentDecisionRecord,
  type DecideEscalation,
  type DecisionPath,
  type DecideVerdict,
  type EscalationCause,
  type EveJudgment,
} from "./record";
