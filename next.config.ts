import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { withEve } from "eve/next";
import { nextConfigRedirects } from "./redirects";

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  async redirects() {
    // The table lives in ./redirects.ts — outside src/ (the rename-sweep
    // audit walks src/) and executable in unit tests without calling this
    // withEve-wrapped config function (build-time side effects).
    return nextConfigRedirects();
  },
  env: sentryBrowserEnv(),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        // ASH-135 s8: without the condition the glob also claims *.module.css,
        // compiling it as global CSS and silently dropping the module scoping.
        // Module files fall through to Turbopack's native CSS Modules handling.
        condition: { not: { path: /\.module\.css$/ } },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Verified API shape: withEve(config, { agents: { <name>: { root } } }).
// polymath is the first-party chief-of-staff agent; specialist serves every
// hired specialist profile (the run's role brief arrives as client context).
const eveConfig = withEve(nextConfig, {
  agents: { polymath: "./eve/polymath", specialist: "./eve/specialist" },
});

// Without a DSN the build skips Sentry's config wrapper entirely, so the laptop
// and CI build what they built before Sentry was added.
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);

// withEve returns an async (phase, context) config function; withSentryConfig
// accepts either form and awaits the inner result before patching it.
export default sentryDsn
  ? withSentryConfig(eveConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Upload logs are the only build output worth reading from the plugin.
      silent: !uploadSourceMaps,
      telemetry: false,
      sourcemaps: uploadSourceMaps
        ? // Uploaded maps are deleted from .next afterwards so the browser
          // never receives them.
          { deleteSourcemapsAfterUpload: true }
        : // Without credentials nothing could upload them, and maps left in
          // .next/static would be served to anyone.
          { disable: true },
      // A Sentry outage must not block a deploy; the release just lacks maps.
      errorHandler: (error) => console.warn("[sentry] source map upload failed:", error.message),
    })
  : eveConfig;

// Values the browser SDK reads, inlined at build time. The DSN is pinned even
// when unset: Next leaves an undefined NEXT_PUBLIC_* reference to be read at
// runtime, which keeps the whole browser SDK in the bundle, while an empty
// string lets the compiler drop it.
function sentryBrowserEnv(): Record<string, string> {
  const env: Record<string, string> = { NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "" };
  for (const name of ["SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}
