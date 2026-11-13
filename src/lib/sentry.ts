import type { BrowserOptions, Event, NodeOptions } from "@sentry/nextjs";

/*
 * One Sentry configuration for the browser, Node and edge runtimes. Each
 * runtime calls `Sentry.init` only when it has a DSN, so with no DSN set (the
 * laptop and CI) nothing initialises and nothing leaves the process.
 *
 * Privacy is the constraint here, not a default: events must not carry the
 * session cookie, bearer tokens, the `x-polymath-session` / `x-api-key`
 * secrets, request bodies, prompts, query parameters or local variables (all
 * of which can hold the person's notes), or the person's email or IP. Session
 * Replay is left out for the same reason.
 */

// Satisfies every runtime's `Sentry.init`, so one object serves all three.
type SentryOptions = BrowserOptions & NodeOptions;

// Request headers worth keeping for triage. An allowlist, because every new
// secret-bearing header would otherwise leak until someone remembered to deny
// it (x-forwarded-for and x-real-ip also carry the person's IP).
const KEPT_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "host", "referer", "user-agent"];

const DEFAULT_TRACES_SAMPLE_RATE = 0.05;

export function sentryOptions(dsn: string): SentryOptions {
  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    sampleRate: 1,
    tracesSampleRate: tracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    // SDK v11 replaced `sendDefaultPii` with this, and every field defaults to
    // collecting. `userInfo: false` also stops Sentry inferring the IP.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: KEPT_REQUEST_HEADERS }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}

// A malformed override falls back to the default instead of silently turning
// tracing off (NaN) or up to everything (a typo like "5").
function tracesSampleRate(raw: string | undefined): number {
  const rate = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

// Backstop for data that reaches an event without passing through
// `dataCollection`, such as the request headers Next hands to onRequestError.
function scrubEvent<T extends Event>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(
        Object.entries(event.request.headers).filter(([name]) => KEPT_REQUEST_HEADERS.includes(name.toLowerCase())),
      );
    }
  }
  if (event.user) {
    delete event.user.email;
    delete event.user.ip_address;
    delete event.user.username;
  }
  return event;
}
