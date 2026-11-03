import { eq } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { users } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";
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
