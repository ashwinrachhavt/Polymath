import type { ErrorEvent } from "@sentry/nextjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentryOptions } from "@/lib/sentry";

/*
 * What Sentry receives is the privacy contract: no session cookie, no secret
 * headers, no request body (the person's notes), no email or IP. The scrub runs
 * inside the SDK's beforeSend, so it is exercised through the options every
 * runtime passes to Sentry.init.
 */
const DSN = "https://public@o0.ingest.sentry.io/0";

afterEach(() => vi.unstubAllEnvs());

function send(event: ErrorEvent) {
  return sentryOptions(DSN).beforeSend?.(event, {});
}

describe("sentryOptions beforeSend", () => {
  it("strips cookies, body, query, secret headers and identifying user fields", () => {
    const sent = send({
      type: undefined,
      request: {
        url: "https://polymath.example/notes/1",
        method: "POST",
        cookies: { __session: "clerk-jwt" },
        data: '{"body":"private note"}',
        query_string: "q=private",
        headers: {
          Cookie: "__session=clerk-jwt",
          authorization: "Bearer secret",
          "x-polymath-session": "secret",
          "x-api-key": "secret",
          "x-forwarded-for": "203.0.113.7",
          "user-agent": "Firefox",
          "Content-Type": "application/json",
        },
      },
      user: { id: "user_1", email: "a@b.c", ip_address: "203.0.113.7", username: "ash" },
    });

    expect(sent).toMatchObject({
      request: {
        url: "https://polymath.example/notes/1",
        headers: { "user-agent": "Firefox", "Content-Type": "application/json" },
      },
      user: { id: "user_1" },
    });
    const request = (sent as ErrorEvent).request!;
    expect(request.cookies).toBeUndefined();
    expect(request.data).toBeUndefined();
    expect(request.query_string).toBeUndefined();
    expect(Object.keys(request.headers!)).toEqual(["user-agent", "Content-Type"]);
    expect((sent as ErrorEvent).user).toEqual({ id: "user_1" });
  });

  it("passes an event without request or user through", () => {
    const event: ErrorEvent = { type: undefined, message: "boom" };
    expect(send(event)).toEqual({ type: undefined, message: "boom" });
  });
});

describe("sentryOptions sampling", () => {
  it("keeps every error and traces 5% by default", () => {
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "");
    expect(sentryOptions(DSN)).toMatchObject({ dsn: DSN, sampleRate: 1, tracesSampleRate: 0.05 });
  });

  // v11's dataCollection collects everything unless told otherwise; these are
  // the categories that can hold the person's identity or their notes.
  it("turns off collection of user info, cookies, bodies, prompts and query data", () => {
    expect(sentryOptions(DSN).dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });

  it("honours a valid override and ignores a malformed one", () => {
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "0.2");
    expect(sentryOptions(DSN).tracesSampleRate).toBe(0.2);
    for (const bad of ["5", "-1", "abc"]) {
      vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", bad);
      expect(sentryOptions(DSN).tracesSampleRate).toBe(0.05);
    }
  });

  it("takes the environment from SENTRY_ENVIRONMENT, else NODE_ENV", () => {
    vi.stubEnv("SENTRY_ENVIRONMENT", "staging");
    expect(sentryOptions(DSN).environment).toBe("staging");
    vi.stubEnv("SENTRY_ENVIRONMENT", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(sentryOptions(DSN).environment).toBe("production");
  });
});
