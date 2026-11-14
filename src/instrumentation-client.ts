import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

// next.config pins NEXT_PUBLIC_SENTRY_DSN as a build-time constant ("" when
// unset), so a build without it compiles both branches and the SDK away.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    ...sentryOptions(dsn),
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })],
  });
}

export const onRouterTransitionStart = dsn ? Sentry.captureRouterTransitionStart : undefined;
