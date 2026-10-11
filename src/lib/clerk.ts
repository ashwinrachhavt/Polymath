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
