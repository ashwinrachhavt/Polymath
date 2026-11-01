/*
 * Clerk is opt-in on configuration. A clean clone, CI, and any preview without
 * env vars still have to boot — @clerk/nextjs throws on a missing publishable
 * key from inside <ClerkProvider>, so both it and the proxy ask here first.
 *
 * Server-only and env-only, so the edge runtime can import it.
 */

export const clerkConfigured =
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) &&
  Boolean(process.env.CLERK_SECRET_KEY);

/*
 * Local testing without Clerk. Set POLYMATH_DEV_AUTH=1 to skip the sign-in
 * redirect and resolve a fixed `dev-user` owner, which auto-provisions its
 * personal workspace on first request.
 *
 * Impossible in production: NODE_ENV is checked here, not by the caller, so a
 * stray env var in a deployment cannot open the app. Useful for exercising a
 * signed-in screen on a laptop without cycling a real session.
 */
export const devAuthBypass =
  process.env.POLYMATH_DEV_AUTH === "1" && process.env.NODE_ENV !== "production";

/*
 * Whether the proxy (src/proxy.ts) enforces sessions at the edge. The bypass
 * only exists outside production (it is false there by definition), so the
 * proxy's spelled-out arm condition reduces to this. next.config.ts reads it
 * too: a static "/" redirect can only exist while the proxy is a
 * pass-through, or config redirects — which run before the proxy — would
 * recreate the two-hop signed-out root (QA F9).
 */
export const proxyArmed = clerkConfigured && !devAuthBypass;
