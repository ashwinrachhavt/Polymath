/**
 * A thin HTTP client for Mercury Decide (`POST /v1/decisions`).
 *
 * Thin means: Bearer auth, a timeout, typed error paths, and just enough
 * response validation that a malformed body surfaces as a `DecideError` instead
 * of an untyped answer. No retries here — retry policy belongs to the caller
 * (the effects queue's backoff, or the assessor). `retryable` says which side
 * of that line a failure sits on: rate limits, upstream 5xx, timeouts, and
 * transport failures may be retried; account, authorization, and request-shape
 * errors may not.
 *
 * The client is the port the superagent assessor consumes — beside `Assessor`
 * and `Executor` in the core's port family. The Engine never sees it: no
 * Decide in core, so the Engine stays deterministic.
 */
import type { DecideAnswer, DecideRequest, DecideResponse, DecideSpan } from "./types";

/** The only model the Decisions endpoint serves. Decisions-only: it does not serve `/chat/completions`, so it is deliberately absent from the chat model catalog. */
export const DECIDE_MODEL_ID = "mercury-decide";

/** Same account, same base URL as the chat catalog's `mercury` entry; the Decisions endpoint hangs off it. */
export const DECIDE_BASE_URL = "https://api.inceptionlabs.ai/v1";

export class DecideError extends Error {
  /** HTTP status, or 0 for a failure before a response arrived (timeout, transport). */
  readonly status: number;
  /** Machine-readable code: the API's `error.code`, or `timeout` / `transport` / `invalid_response`. */
  readonly code: string;
  /** The API's `error.type` category (`rate_limit_error`, `server_error`, …), when the response carried one. */
  readonly errorType: string | null;
  /** Whether the caller may retry: 429, upstream 5xx, timeouts, and transport failures; never account or request-shape errors. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status: number; code: string; errorType?: string | null; retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "DecideError";
    this.status = options.status;
    this.code = options.code;
    this.errorType = options.errorType ?? null;
    this.retryable = options.retryable;
  }
}

export interface DecideClientConfig {
  apiKey: string;
  baseUrl?: string;
  /** Model the request answers with when the request itself names none. */
  model?: string;
  /** Per-call timeout in milliseconds; the default is 30s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The port: one typed decision per call. */
export interface DecideClient {
  decide(request: DecideRequest): Promise<DecideResponse>;
}

/** Statuses that may succeed on a retry: rate limiting and upstream trouble, not our own mistakes. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function decideClient(config: DecideClientConfig): DecideClient {
  const baseUrl = (config.baseUrl ?? DECIDE_BASE_URL).replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  return {
    async decide(request: DecideRequest): Promise<DecideResponse> {
      const body = JSON.stringify({
        model: request.model ?? config.model ?? DECIDE_MODEL_ID,
        state: request.state,
        questions: request.questions,
      });
      // The timeout fires into `controller.abort`; on abort, fetch rejects with
      // that reason, which the catch below maps to the typed timeout error.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError")),
        timeoutMs,
      );
      let response: globalThis.Response;
      try {
        response = await fetchImpl(`${baseUrl}/decisions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw new DecideError(
          timedOut
            ? `Decision request timed out after ${timeoutMs}ms`
            : "Decision request failed before a response arrived",
          { status: 0, code: timedOut ? "timeout" : "transport", retryable: true, cause },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) throw await decisionError(response);

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (cause) {
        throw new DecideError("Decision endpoint returned a non-JSON body", {
          status: response.status,
          code: "invalid_response",
          retryable: true,
          cause,
        });
      }
      return parseResponse(parsed, response.status);
    },
  };
}

/** A Decide client from the environment, or null when no Inception key is set — callers skip the seam the same way they skip an unconfigured generation provider. Key order matches the chat catalog's `mercury` entry. */
export function decideClientFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): DecideClient | null {
  const apiKey = ["MERCURY_API_KEY", "INCEPTION_API_KEY"]
    .map((k) => env[k])
    .find((v) => typeof v === "string" && v.length > 0);
  if (!apiKey) return null;
  return decideClient({ apiKey, fetchImpl });
}

/** The error envelope: `{ error: { message, type, code } }`, or FastAPI's `{ detail: [{ loc, msg }] }` for request validation. */
async function decisionError(response: globalThis.Response): Promise<DecideError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON error body still deserves its status and code; keep going.
  }
  const envelope =
    typeof body === "object" && body !== null && "error" in body
      ? stringsOf((body as { error: unknown }).error)
      : undefined;
  const detail =
    typeof body === "object" && body !== null && "detail" in body ? (body as { detail: unknown }).detail : undefined;

  let message = envelope?.message ?? `Decision endpoint returned ${response.status} ${response.statusText}`;
  if (!envelope?.message && Array.isArray(detail)) {
    const parts = detail
      .map((item) => (typeof item === "object" && item !== null ? stringsOf(item) : undefined))
      .filter((item): item is Record<string, string> => item !== undefined)
      .map((item) => [item.loc, item.msg].filter(Boolean).join(": "));
    if (parts.length > 0) message = parts.join("; ");
  }

  return new DecideError(message, {
    status: response.status,
    code: envelope?.code ?? "decide_error",
    errorType: envelope?.type ?? null,
    retryable: RETRYABLE_STATUSES.has(response.status),
  });
}

function stringsOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
    else if (Array.isArray(raw))
      out[key] = raw
        .map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : ""))
        .filter(Boolean)
        .join(".");
  }
  return out;
}

/**
 * Validate and map the wire response into the typed shape. Unknown fields the
 * live API adds (`cost`, `elapsedMs`) are dropped; a known question type with a
 * malformed answer, or an unknown type, is an error — an untyped Decide
 * response must never reach a caller that trusts its types.
 */
function parseResponse(body: unknown, status: number): DecideResponse {
  const invalid = (why: string): DecideError =>
    new DecideError(`Decision endpoint returned an untyped response: ${why}`, {
      status,
      code: "invalid_response",
      retryable: true,
    });
  if (typeof body !== "object" || body === null) throw invalid("body is not an object");
  const { model, answers, usage } = body as Record<string, unknown>;
  if (typeof model !== "string" || model.length === 0) throw invalid("`model` is missing");
  if (typeof answers !== "object" || answers === null) throw invalid("`answers` is missing");
  if (typeof usage !== "object" || usage === null) throw invalid("`usage` is missing");
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage as Record<string, unknown>;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") throw invalid("`usage` lacks token counts");

  const mapped: Record<string, DecideAnswer> = {};
  for (const [name, raw] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) throw invalid(`answer "${name}" is not an object`);
    const answer = raw as Record<string, unknown>;
    switch (answer.type) {
      case "noul":
        if (typeof answer.noul !== "number") throw invalid(`answer "${name}" lacks a probability`);
        mapped[name] = { type: "noul", probability: answer.noul };
        break;
      case "choice":
        if (typeof answer.choice !== "string") throw invalid(`answer "${name}" lacks a choice`);
        if (!isNumbers(answer.probabilities) || typeof answer.confidence !== "number")
          throw invalid(`answer "${name}" lacks probabilities`);
        mapped[name] = {
          type: "choice",
          choice: answer.choice,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
        };
        break;
      case "score":
        if (typeof answer.score !== "number") throw invalid(`answer "${name}" lacks a score`);
        if (!isStrings(answer.legend) || !isNumbers(answer.probabilities) || typeof answer.confidence !== "number")
          throw invalid(`answer "${name}" lacks its legend or probabilities`);
        mapped[name] = {
          type: "score",
          score: answer.score,
          legend: answer.legend,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
        };
        break;
      case "extract": {
        if (typeof answer.spans !== "object" || answer.spans === null) throw invalid(`answer "${name}" lacks spans`);
        if (typeof answer.not_stated !== "object" || answer.not_stated === null)
          throw invalid(`answer "${name}" lacks not-stated probabilities`);
        const spans: Record<string, DecideSpan[]> = {};
        for (const [field, list] of Object.entries(answer.spans as Record<string, unknown>)) {
          if (!Array.isArray(list)) throw invalid(`answer "${name}" field "${field}" is not a span list`);
          spans[field] = list.map((span) => {
            if (typeof span !== "object" || span === null)
              throw invalid(`answer "${name}" field "${field}" holds a non-span`);
            const s = span as Record<string, unknown>;
            if (
              typeof s.text !== "string" ||
              typeof s.start !== "number" ||
              typeof s.end !== "number" ||
              typeof s.confidence !== "number"
            )
              throw invalid(`answer "${name}" field "${field}" holds a malformed span`);
            return { text: s.text, start: s.start, end: s.end, confidence: s.confidence };
          });
        }
        const notStated: Record<string, number> = {};
        for (const [field, value] of Object.entries(answer.not_stated as Record<string, unknown>)) {
          if (typeof value !== "number")
            throw invalid(`answer "${name}" field "${field}" lacks a not-stated probability`);
          notStated[field] = value;
        }
        mapped[name] = { type: "extract", spans, notStated };
        break;
      }
      default:
        throw invalid(`answer "${name}" has an unknown type`);
    }
  }
  return { model, answers: mapped, usage: { inputTokens, outputTokens } };
}

function isNumbers(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "number");
}

function isStrings(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
}
