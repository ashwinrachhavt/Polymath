import type { Metadata } from "next";
import { SignOutButton } from "@clerk/nextjs";
import { ClerkAuthProvider } from "@/components/auth/clerk-auth-provider";
import { Button } from "@/components/ui/button";
import { clerkConfigured } from "@/lib/clerk";

export const metadata: Metadata = { title: "Invite only · Polymath" };

/*
 * Where src/proxy.ts sends a signed-in account that is not on
 * POLYMATH_ALLOWED_EMAILS (src/lib/access-allowlist.ts). Public, so it renders
 * without touching anything that could provision the visitor. Signing out is
 * the one useful action: it lets someone who signed in with the wrong account
 * try again.
 */
export default function InviteOnlyPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col gap-4 text-center">
        <h1 className="text-lg font-medium tracking-tight">This Polymath is invite-only</h1>
        <p className="text-muted-foreground text-body-dense">
          The account you signed in with is not on the invite list. If you were invited, sign out and sign in with the
          email address the invitation went to.
        </p>
        {clerkConfigured ? (
          <ClerkAuthProvider>
            <SignOutButton redirectUrl="/landing">
              <Button variant="outline" className="self-center">
                Sign out
              </Button>
            </SignOutButton>
          </ClerkAuthProvider>
        ) : null}
      </div>
    </main>
  );
}
