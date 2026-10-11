import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { clerkConfigured } from "@/lib/clerk";

/*
 * A placeholder until the Briefing lands. It shows the identity seam working —
 * signed in, signed out, or no Clerk project at all — which is the one thing
 * worth proving before the shell exists.
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-medium tracking-tight">Axiom</h1>
      <p className="text-muted-foreground max-w-prose">
        Foundation scaffold. The shell, tenancy, and the first vertical slice land next.
      </p>
      {clerkConfigured ? (
        <div className="flex items-center gap-3 text-sm">
          <SignedIn>
            <UserButton />
            <Link
              href="/sign-in"
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              Switch account
            </Link>
          </SignedIn>
          <SignedOut>
            <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
              Sign in
            </Link>
          </SignedOut>
        </div>
      ) : null}
    </main>
  );
}
