import { SignUp } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { clerkConfigured } from "@/lib/clerk";

export const metadata = { title: "Create account · Axiom" };

/* Mirrors src/app/sign-in: the route exists only when Clerk is configured. */
export default function SignUpPage() {
  if (!clerkConfigured) notFound();
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <SignUp />
    </main>
  );
}
