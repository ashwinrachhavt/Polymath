import Link from "next/link";

/* An empty screen is an invitation to act, never a mood (agents/product.md). */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 p-6">
      <h1 className="text-lg font-medium tracking-tight">Nothing is here</h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        This address does not match anything in Axiom. It may have been renamed or deleted.
      </p>
      <Link href="/" className="text-primary w-fit text-sm underline-offset-4 hover:underline">
        Back to the briefing
      </Link>
    </main>
  );
}
