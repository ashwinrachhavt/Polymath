/*
 * Where the OAuth callback belongs. The callback URL is sent to Composio and
 * the provider redirects the browser back to it carrying the state token, so
 * the origin must be one this deployment actually owns: a request's Host /
 * X-Forwarded-Host header is client-supplied and an attacker who got a
 * poisoned host into a connect would receive the OAuth return - state token
 * included - on their own domain.
 *
 * APP_ORIGIN wins when set (operator-declared, trusted). Otherwise the
 * request's host is used only when it matches an origin the platform itself
 * reports for this deployment (Vercel's VERCEL_* env) or localhost in dev.
 * Anything else is refused rather than guessed.
 */
export function resolveRequestOrigin(input: {
  host: string | null;
  proto: string | null;
  env?: Partial<Record<string, string | undefined>>;
}): { ok: true; origin: string } | { ok: false; error: string } {
  const env = input.env ?? process.env;
  if (env.APP_ORIGIN) return { ok: true, origin: env.APP_ORIGIN };

  const host = input.host?.trim();
  if (!host) {
    // No way to know where the browser came from; dev default.
    return { ok: true, origin: "http://localhost:3000" };
  }

  const trusted = new Set<string>();
  for (const value of [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL, env.VERCEL_URL]) {
    if (value) trusted.add(value.toLowerCase());
  }
  const lower = host.toLowerCase();
  const isLocalhost = /^localhost(:\d+)?$/.test(lower) || /^127\.0\.0\.1(:\d+)?$/.test(lower);
  if (!trusted.has(lower) && !isLocalhost) {
    return {
      ok: false,
      error:
        "This deployment's origin could not be verified. Set APP_ORIGIN to the app's public URL and try again.",
    };
  }
  // Vercel deployments only ever serve https; localhost is plain http in dev.
  return { ok: true, origin: `${isLocalhost ? "http" : "https"}://${host}` };
}
