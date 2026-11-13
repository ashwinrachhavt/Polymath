import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

// Runs once per server instance, in both the Node and edge runtimes; the
// package's export conditions pick the matching SDK for each. The server may
// carry its own DSN, and otherwise reuses the browser's.
export function register() {
  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (dsn) Sentry.init(sentryOptions(dsn));
}

// Server Component, route handler, server action and proxy errors. Without an
// initialised client this captures nothing and sends nothing.
export const onRequestError = Sentry.captureRequestError;
