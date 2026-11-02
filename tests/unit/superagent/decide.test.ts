import { describe, expect, it, vi } from "vitest";
import {
  DECIDE_BASE_URL,
  DECIDE_MODEL_ID,
  DecideError,
  decideClient,
  decideClientFromEnv,
} from "@/domains/superagent/decide";
import type { DecideQuestion, DecideResponse } from "@/domains/superagent/decide";

/*
 * The Decide client's contract, against a mocked /v1/decisions: the request it
 * builds, the four typed answers it maps (fixtures from the live smoke of
 * 2026-11-02), and every error path the endpoint documents — envelope errors,
 * the FastAPI validation variant, non-JSON bodies, and untyped answers, which
 * must surface as DecideError rather than reach a caller that trusts its types.
 */

/** The live decisions smoke's response, extras (`cost`, `elapsedMs`) included. */
const LIVE_DECISION = {
  model: "mercury-decide",
  answers: {
    refund: { type: "noul", noul: 0.999 },
    team: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9438, shipping: 0.0562 },
      confidence: 0.8877,
    },
    urgency: {
      type: "score",
      score: 0.817,
      legend: { 0: "Can wait", 1: "Needs attention soon" },
      probabilities: { 0: 0.183, 1: 0.817 },
      confidence: 0.634,
    },
    order: {
      type: "extract",
      spans: { order: [{ text: "#A-1042", start: 6, end: 13, confidence: 0.9777 }] },
      not_stated: { order: 0.0223 },
    },
  },
  usage: { input_tokens: 206, output_tokens: 0 },
  cost: 0,
  elapsedMs: 216.9,
};

const QUESTIONS: Record<string, DecideQuestion> = {
  refund: { type: "noul", instructions: "Does the buyer ask for their money back?" },
  team: { type: "choice", criteria: { billing: "Payments and refunds", shipping: "Delivery issues" } },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["Can wait", "Needs attention soon"] },
  order: { type: "extract", instructions: "The order id" },
};

function jsonBody(result: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(typeof result === "string" ? result : JSON.stringify(result), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "",
    headers: { "content-type": "application/json" },
  });
}

const client = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  decideClient({ apiKey: "test-key", fetchImpl, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

/** The one captured call of a fetch mock, with `init` narrowed to a plain RequestInit. */
function firstCall(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { url: string; init: RequestInit } {
  const [input, init] = fetchImpl.mock.calls[0]!;
  return { url: String(input), init: init ?? {} };
}

describe("decideClient request", () => {
  it("posts to /decisions with Bearer auth and the default model", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonBody(LIVE_DECISION));
    await client(fetchImpl).decide({ state: "state text", questions: { ...QUESTIONS } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe(`${DECIDE_BASE_URL}/decisions`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: DECIDE_MODEL_ID,
      state: "state text",
      questions: { ...QUESTIONS },
    });
  });

  it("honors a request-level model and a config-level base URL override", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonBody(LIVE_DECISION));
    await decideClient({ apiKey: "k", baseUrl: "https://proxy.example/v1", fetchImpl }).decide({
      model: "mercury-decide-preview",
      state: "s",
      questions: { q: { type: "noul" } },
    });
    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe("https://proxy.example/v1/decisions");
    expect(JSON.parse(init.body as string).model).toBe("mercury-decide-preview");
  });
});

describe("decideClient typed answers", () => {
  it("maps the four answer kinds from the wire names to the typed shape", async () => {
    const response: DecideResponse = await client(async () => jsonBody(LIVE_DECISION)).decide({
      state: "s",
      questions: { ...QUESTIONS },
    });
    expect(response.model).toBe("mercury-decide");
    expect(response.usage).toEqual({ inputTokens: 206, outputTokens: 0 });
    const { refund, team, urgency, order } = response.answers;
    expect(refund).toEqual({ type: "noul", probability: 0.999 });
    expect(team).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9438, shipping: 0.0562 },
      confidence: 0.8877,
    });
    expect(urgency).toEqual({
      type: "score",
      score: 0.817,
      legend: { 0: "Can wait", 1: "Needs attention soon" },
      probabilities: { 0: 0.183, 1: 0.817 },
      confidence: 0.634,
    });
    // A text-span answer: exact span, [start, end) offsets, and the not-stated probability.
    expect(order).toEqual({
      type: "extract",
      spans: { order: [{ text: "#A-1042", start: 6, end: 13, confidence: 0.9777 }] },
      notStated: { order: 0.0223 },
    });
  });

  it("keeps mapping when the live API adds fields the schema does not name", async () => {
    // `cost` and `elapsedMs` ride along on the live response; dropping them is the
    // parser's job, not a failure.
    const response: DecideResponse = await client(async () => jsonBody(LIVE_DECISION)).decide({
      state: "s",
      questions: { q: { type: "noul" } },
    });
    expect(response.answers.refund).toEqual({ type: "noul", probability: 0.999 });
  });
});

describe("decideClient error paths", () => {
  const expectError = async (
    result: Promise<DecideResponse>,
    expected: { status: number; code: string; retryable: boolean; message?: string },
  ) => {
    await expect(result).rejects.toBeInstanceOf(DecideError);
    const error = (await result.catch((e: DecideError) => e)) as DecideError;
    expect(error.status).toBe(expected.status);
    expect(error.code).toBe(expected.code);
    expect(error.retryable).toBe(expected.retryable);
    if (expected.message) expect(error.message).toContain(expected.message);
  };

  it("maps the envelope errors with their retryability", async () => {
    const rows: [number, unknown, boolean, string][] = [
      [
        401,
        { error: { message: "Incorrect API key provided", type: "authentication_error", code: "invalid_api_key" } },
        false,
        "invalid_api_key",
      ],
      [
        402,
        { error: { code: "account_error", type: "invalid_request_error", message: "Account access is unavailable." } },
        false,
        "account_error",
      ],
      [
        404,
        { error: { code: "model_not_found", type: "invalid_request_error", message: "Decision model not found." } },
        false,
        "model_not_found",
      ],
      [
        413,
        { error: { code: "request_too_large", type: "invalid_request_error", message: "Request body is too large." } },
        false,
        "request_too_large",
      ],
      [
        429,
        {
          error: {
            code: "rate_limit_exceeded",
            type: "rate_limit_error",
            message: "Request or spending limit exceeded.",
          },
        },
        true,
        "rate_limit_exceeded",
      ],
      [
        500,
        { error: { message: "Internal server error", type: "server_error", code: "server_error" } },
        true,
        "server_error",
      ],
      [
        502,
        {
          error: {
            code: "upstream_error",
            type: "server_error",
            message: "Decision service returned an invalid response.",
          },
        },
        true,
        "upstream_error",
      ],
      [
        504,
        { error: { code: "upstream_timeout", type: "server_error", message: "Decision service timed out." } },
        true,
        "upstream_timeout",
      ],
    ];
    for (const [status, body, retryable, code] of rows) {
      const result = client(async () => jsonBody(body, { status })).decide({
        state: "s",
        questions: { q: { type: "noul" } },
      });
      await expectError(result, { status, code, retryable });
    }
  });

  it("maps the FastAPI validation variant of 422", async () => {
    const body = { detail: [{ loc: ["body", "questions"], msg: "Field required", type: "missing" }] };
    const result = client(async () => jsonBody(body, { status: 422 })).decide({
      state: "s",
      questions: { q: { type: "noul" } },
    });
    await expectError(result, {
      status: 422,
      code: "decide_error",
      retryable: false,
      message: "body.questions: Field required",
    });
  });

  it("keeps a non-JSON error body an error, not a crash", async () => {
    const result = client(async () => new Response("<html>gateway</html>", { status: 503 })).decide({
      state: "s",
      questions: { q: { type: "noul" } },
    });
    await expectError(result, { status: 503, code: "decide_error", retryable: true, message: "503" });
  });

  it("surfaces a malformed success body as an untyped-response error", async () => {
    for (const body of [
      "not json at all",
      { answers: "nope", usage: {} },
      {
        model: "mercury-decide",
        answers: { q: { type: "vibes", level: 3 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      { model: "mercury-decide", answers: { q: { type: "noul" } }, usage: { input_tokens: 1, output_tokens: 0 } },
      {
        model: "mercury-decide",
        answers: { q: { type: "extract", spans: { f: [{ text: "x" }] } }, not_stated: { f: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    ]) {
      const result = client(async () => jsonBody(body)).decide({ state: "s", questions: { q: { type: "noul" } } });
      await expectError(result, { status: 200, code: "invalid_response", retryable: true });
    }
  });

  it("maps a timeout to a retryable status-0 error", async () => {
    const hanging = (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const result = client(hanging, 10).decide({ state: "s", questions: { q: { type: "noul" } } });
    await expectError(result, { status: 0, code: "timeout", retryable: true, message: "timed out after 10ms" });
  });

  it("maps a transport failure to a retryable status-0 error", async () => {
    const result = client(async () => {
      throw new TypeError("fetch failed");
    }).decide({ state: "s", questions: { q: { type: "noul" } } });
    await expectError(result, { status: 0, code: "transport", retryable: true });
  });
});

describe("decideClientFromEnv", () => {
  it("is null when no Inception key is set, and prefers MERCURY_API_KEY", () => {
    expect(decideClientFromEnv({})).toBeNull();
    expect(decideClientFromEnv({ INCEPTION_API_KEY: "a", MERCURY_API_KEY: "m" })).not.toBeNull();
  });
});
