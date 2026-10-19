import { SignIn } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { afterAuthUrl, clerkAppearance } from "@/lib/clerk-appearance";
import { clerkConfigured } from "@/lib/clerk";

export const metadata = { title: "Sign in · Polymath" };

/*
 * Identity is opt-in on configuration, so this route only exists when Clerk
 * does — otherwise it 404s rather than rendering a component that would throw.
 */
export default function SignInPage() {
  if (!clerkConfigured) notFound();
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <SignIn
        appearance={clerkAppearance}
        forceRedirectUrl={afterAuthUrl}
        signUpUrl="/sign-up"
      />
    </main>
  );
}
