import { createClerkClient } from "@clerk/nextjs/server";

/*
 * Invite-only access for a publicly reachable deployment. A Clerk instance
 * that allows sign-ups would otherwise let anyone who finds the URL create an
 * account, get a workspace provisioned, and spend the deployment's model keys.
 *
 * POLYMATH_ALLOWED_EMAILS is a comma-separated list of email addresses. Unset
 * or blank, access is not restricted (the laptop, CI, and any deployment that
 * gates sign-ups in Clerk itself). Set, a Clerk user gets in only when one of
 * their *verified* addresses is listed: an unverified address is something
 * the visitor typed, not something the identity provider vouched for.
 *
 * Callers: src/proxy.ts sends an unlisted session to /invite-only before any
 * page or API runs, and src/lib/auth.ts checks again before resolving (and so
 * provisioning) a user, so no row is created for a stranger even if a request
 * reaches the app some other way.
 */

/** The allowlist, lowercased, or null when access is unrestricted. */
export function allowedEmails(
  raw: string | undefined = process.env.POLYMATH_ALLOWED_EMAILS,
): ReadonlySet<string> | null {
  const emails = (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return emails.length > 0 ? new Set(emails) : null;
}

type ClerkEmail = { emailAddress: string; verification: { status: string } | null };

/** True when one of the user's verified addresses is on the list. */
export function hasAllowedEmail(emails: readonly ClerkEmail[], allowed: ReadonlySet<string>): boolean {
  return emails.some((e) => e.verification?.status === "verified" && allowed.has(e.emailAddress.trim().toLowerCase()));
}

// Per-process cache of the Clerk lookup, so a signed-in user costs one Backend
// API request per few minutes rather than one per request (the proxy runs on
// every navigation and prefetch). A denial expires sooner, so a newly listed
// user is let in quickly after a deploy. Lookup failures are never cached.
const ALLOWED_TTL_MS = 5 * 60_000;
const DENIED_TTL_MS = 60_000;
const decisions = new Map<string, { allowed: boolean; expiresAt: number }>();

type LookupEmails = (clerkUserId: string) => Promise<readonly ClerkEmail[]>;

const lookupClerkEmails: LookupEmails = async (clerkUserId) => {
  // The Backend API client takes env-configured options and the user id
  // explicitly, so it works in the proxy as well as in server code.
  const user = await createClerkClient({}).users.getUser(clerkUserId);
  return user.emailAddresses;
};

/**
 * Whether a Clerk user may use this deployment. Always true when no allowlist
 * is configured. Fails closed: if Clerk cannot be asked, the answer is no.
 */
export async function isClerkUserAllowed(
  clerkUserId: string,
  options: { allowed?: ReadonlySet<string> | null; lookup?: LookupEmails; now?: number } = {},
): Promise<boolean> {
  const allowed = options.allowed === undefined ? allowedEmails() : options.allowed;
  if (allowed === null) return true;

  const now = options.now ?? Date.now();
  const cached = decisions.get(clerkUserId);
  if (cached && cached.expiresAt > now) return cached.allowed;

  let decision: boolean;
  try {
    decision = hasAllowedEmail(await (options.lookup ?? lookupClerkEmails)(clerkUserId), allowed);
  } catch {
    return false;
  }
  decisions.set(clerkUserId, { allowed: decision, expiresAt: now + (decision ? ALLOWED_TTL_MS : DENIED_TTL_MS) });
  return decision;
}

/** Test seam: forget cached decisions. */
export function resetAllowlistCache(): void {
  decisions.clear();
}
