/*
 * Thin HTTP client for TypeSafe's hosted judgment API (ASH-272). One
 * endpoint, POST /v1/systemone: the request carries the content as `state`
 * plus every question bundled (questions are evaluated in parallel
 * server-side, so the state is paid for once). Plain fetch keeps deps at
 * zero; the error discipline mirrors the generation seam - unconfigured is a
 * distinct error from a request failure, and one call never hangs a run.
 *
 * Contract verified 2026-10-25 against https://docs.typesafe.ai/api/system-one
 * and /primitives/choice: noul answers are { type, noul } probabilities;
 * choice answers are { type, choice, confidence, probabilities }; usage is
 * { input_tokens, output_tokens } (output tokens are free, billing is input
 * only).
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_TIMEOUT_MS = 30_000;
export const DEFAULT_JEV_MODEL = "jev-1.14.0";

export class JevUnconfiguredError extends Error {
  constructor() {
    super("Jev is not configured. Set TYPESAFE_API_KEY.");
    this.name = "JevUnconfiguredError";
  }
}

export class JevRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`Jev request failed (${provider}, HTTP ${status})`);
    this.name = "JevRequestError";
  }
}

export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string } | null;
};

export type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export type JevResponse = {
  /** The versioned model id that answered (aliases resolve server-side). */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type JevRequest = {
  state: string;
  questions: Record<string, JevQuestion>;
};

/** The narrow surface the provider and tests depend on. */
export interface JevClient {
  systemOne(input: JevRequest): Promise<JevResponse>;
}

export function httpJevClient(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): JevClient {
  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) throw new JevUnconfiguredError();
  return {
    async systemOne(input) {
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: env.JEV_MODEL || DEFAULT_JEV_MODEL, state: input.state, questions: input.questions }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Provider text can carry account detail; callers get status only.
        throw new JevRequestError("jev", response.status);
      }
      const body = (await response.json().catch(() => null)) as JevResponse | null;
      if (!body || typeof body !== "object" || !body.answers || !body.usage) {
        throw new JevRequestError("jev", 0);
      }
      return body;
    },
  };
}
