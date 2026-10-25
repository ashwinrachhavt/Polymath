import { SignUp } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { afterAuthUrl } from "@/lib/clerk-appearance";
import { ClerkAuthProvider } from "@/components/auth/clerk-auth-provider";
import { clerkConfigured } from "@/lib/clerk";

export const metadata = { title: "Create account · Polymath" };

/* Mirrors src/app/sign-in: the route exists only when Clerk is configured. */
export default function SignUpPage() {
  if (!clerkConfigured) notFound();
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <ClerkAuthProvider>
        <SignUp forceRedirectUrl={afterAuthUrl} />
      </ClerkAuthProvider>
    </main>
  );
}
