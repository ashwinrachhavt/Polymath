import { SignIn } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { clerkConfigured } from "@/lib/clerk";

export const metadata = { title: "Sign in · Axiom" };

/*
 * Identity is opt-in on configuration, so this route only exists when Clerk
 * does — otherwise it 404s rather than rendering a component that would throw.
 */
export default function SignInPage() {
  if (!clerkConfigured) notFound();
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <SignIn />
    </main>
  );
}
