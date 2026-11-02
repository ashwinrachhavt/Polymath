/**
 * The Mercury Decide wire contract (`POST /v1/decisions`), typed.
 *
 * Decide is not chat-completions shaped: one call carries a shared `state`
 * (text, JSON object, or array) and a map of named, typed questions, and the
 * answer comes back typed with calibrated probabilities. There is no streaming
 * and no tool calling. Shapes verified against the live API on 2026-11-02
 * (smoke: noul, choice, score, and extract all answered) and against the
 * OpenAPI document at docs.inceptionlabs.ai — whose schema does not yet list
 * `extract`, though the live endpoint does. The extra fields the live response
 * carries (`cost`, `elapsedMs`) are deliberately dropped rather than typed.
 */

/** A JSON value, as the API accepts one in `state`, `instructions`, and criteria descriptions. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Shared context every question is evaluated against: plain text, a JSON object, or an array. */
export type DecideState = string | { [key: string]: JsonValue } | JsonValue[];

/**
 * Binary-probability question (wire type `noul`): the answer is the probability
 * of a positive answer, 0 to 1.
 */
export interface DecideBinaryQuestion {
  type: "noul";
  instructions?: string;
  /** Optional descriptions of what counts as the positive (`true`) or negative (`false`) answer. */
  criteria?: { true?: string; false?: string };
}

/**
 * Categorical question: exactly one of 1-255 named options. The API requires
 * `criteria` — options are never inferred from `instructions` — and a
 * description may be null.
 */
export interface DecideChoiceQuestion {
  type: "choice";
  instructions?: string;
  criteria: Record<string, string | null>;
}

/**
 * Ordinal question: the answer is a probability-weighted level, 0-based into
 * `criteria`, so it can be fractional.
 */
export interface DecideOrdinalQuestion {
  type: "score";
  instructions?: string;
  /** 1-10 ordered level descriptions, level 0 first. */
  criteria: string[];
}

/**
 * Text-span question: exact spans of the state text, with character offsets and
 * confidence. The live endpoint answers an `extract` question with instructions
 * alone; `criteria` names further fields. When `state` is an object the API
 * requires `source`, the string-valued field the offsets measure.
 */
export interface DecideSpanQuestion {
  type: "extract";
  instructions?: string;
  /** Required by the API when `state` is an object. */
  source?: string;
  /** Drop spans below this confidence (0-1); the API default is 0. */
  threshold?: number;
  /** 1-26 field names mapped to plain-language descriptions. */
  criteria?: Record<string, string>;
}

export type DecideQuestion = DecideBinaryQuestion | DecideChoiceQuestion | DecideOrdinalQuestion | DecideSpanQuestion;

/** One exact span of the state text: `[start, end)` offsets into the source string, as the API measured them. */
export interface DecideSpan {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

/** Binary-probability answer (wire type `noul`): the API names the field `noul`. */
export interface DecideBinaryAnswer {
  type: "noul";
  probability: number;
}

/** Categorical answer: the chosen option, its per-option probabilities, and the model's confidence. */
export interface DecideChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Ordinal answer: the probability-weighted level, the level descriptions by stringified index, and the probabilities. */
export interface DecideOrdinalAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Text-span answer: matching spans per field (an empty list means none), and the probability no span exists. */
export interface DecideSpanAnswer {
  type: "extract";
  spans: Record<string, DecideSpan[]>;
  notStated: Record<string, number>;
}

export type DecideAnswer = DecideBinaryAnswer | DecideChoiceAnswer | DecideOrdinalAnswer | DecideSpanAnswer;

export interface DecideRequest {
  /** Defaults to `DECIDE_MODEL_ID` (`mercury-decide`). */
  model?: string;
  state: DecideState;
  questions: Record<string, DecideQuestion>;
}

/** Token usage of one decision call: the Decisions endpoint bills input tokens only. */
export interface DecideUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecideResponse {
  model: string;
  answers: Record<string, DecideAnswer>;
  usage: DecideUsage;
}
