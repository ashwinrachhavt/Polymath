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
 * No account can stand behind a screen only in a keyless PRODUCTION
 * deployment (the hosted browser preview): without Clerk keys auth() throws
 * there. In development and CI the keyless fallback in lib/auth resolves the
 * fixed dev owner, and POLYMATH_DEV_AUTH names the same account explicitly,
 * so a surface that branches on clerkConfigured alone wrongly tells that
 * owner "nothing here is an account" and breaks every account-scoped save
 * with a version-0 CAS conflict (ASH-312).
 */
export const accountlessDeployment =
  !clerkConfigured && !devAuthBypass && process.env.NODE_ENV === "production";
