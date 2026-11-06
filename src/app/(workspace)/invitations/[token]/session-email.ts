import { eq } from "drizzle-orm";
import { createClerkClient, currentUser } from "@clerk/nextjs/server";
import { cacheLife, cacheTag } from "next/cache";
import { users } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";
import { sessionEmailTag } from "@/lib/cache-tags";
import { db } from "@/lib/db";

/*
 * The verified email of the signed-in session, or null when there is not one
 * to trust (spec D4: the pending invitation's email must match the session's
 * Clerk email). With Clerk mounted, `verification.status === "verified"` is
 * the identity provider's own claim - never a value the session could have
 * self-asserted. In the keyless dev harness the session user's stored address
 * stands in for it, which is what the e2e journey's second dev user relies on.
 */
export async function sessionVerifiedEmail(auth: AuthContext): Promise<string | null> {
  if (clerkConfigured && !devAuthBypass) {
    try {
      const user = await currentUser();
      const primary = user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user?.emailAddresses[0];
      return primary?.verification?.status === "verified" ? primary.emailAddress : null;
    } catch {
      // No mounted Clerk context (keyless dev, scripts): treat as unverified.
      return null;
    }
  }
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, auth.userId)).limit(1);
  return row?.email ?? null;
}

/*
 * The cached twin the workspace layout's switcher reads. `currentUser()` opens
 * a Clerk Backend API request and reads request-time auth state, so it cannot
 * run in a cached scope; the Backend API client can, because it takes the
 * user id as an explicit argument and the verified email changes at most once
 * per sign-in. Acceptance keeps calling the uncached sessionVerifiedEmail
 * above - the invitation match is a trust surface, not chrome. A machine
 * session has no Clerk user and reads null here, the same value
 * sessionVerifiedEmail returns for it today.
 */
export async function cachedSessionVerifiedEmail(auth: AuthContext): Promise<string | null> {
  if (clerkConfigured && !devAuthBypass) return cachedClerkVerifiedEmail(auth.clerkUserId);
  return cachedDevVerifiedEmail(auth.userId);
}

async function cachedClerkVerifiedEmail(clerkUserId: string | undefined): Promise<string | null> {
  "use cache";
  cacheTag(sessionEmailTag(clerkUserId ?? "no-clerk-user"));
  cacheLife("minutes"); // the email is fixed at sign-in; the profile bounds a change until its next request
  if (!clerkUserId) return null;
  try {
    // createClerkClient (the backend client) takes env-configured options and
    // never touches `headers()`, unlike `clerkClient()`, so it is safe inside
    // a `"use cache"` scope. The user id is passed explicitly, so the cached
    // result is keyed per Clerk user.
    const client = createClerkClient({});
    const user = await client.users.getUser(clerkUserId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
    return primary?.verification?.status === "verified" ? primary.emailAddress : null;
  } catch {
    // Same honesty rule as sessionVerifiedEmail: an unreachable identity
    // provider reads as "no email to trust", not as a failed render.
    return null;
  }
}

async function cachedDevVerifiedEmail(userId: string): Promise<string | null> {
  "use cache";
  cacheTag(sessionEmailTag(`dev:${userId}`));
  cacheLife("minutes");
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}
