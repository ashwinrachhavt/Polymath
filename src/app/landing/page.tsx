import type { Metadata } from "next";
import Link from "next/link";

/*
 * The one public marketing route (GTM plan, funnel surface). Essays and the
 * waitlist point here; the product itself still lives behind the workspace —
 * the root keeps landing on the Assistant for a signed-in person.
 */
export const metadata: Metadata = {
  title: "Polymath — Understand is the bottleneck",
  description:
    "Polymath turns everything entering your world — mail, files, pages, ideas — into an ordered, trustworthy plan.",
};

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="polymath-mark size-7 text-[15px]">
            P
          </span>
          <span className="text-[15px] font-medium">Polymath</span>
        </span>
        <Link
          href="/alfred"
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:border-foreground/40"
        >
          Open the app
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <h1 className="max-w-5xl font-[family-name:var(--font-display)] text-[clamp(2.75rem,8vw,4.5rem)] font-bold leading-[1.08] tracking-normal text-balance">
          {/* Notion-style highlight: the action word sits in a pill. */}
          <span className="inline-flex items-center gap-[0.28em] rounded-full bg-[oklch(0.93_0.055_145)] px-[0.38em] py-[0.06em] text-[oklch(0.27_0.008_75)] align-baseline">
            <span
              aria-hidden
              className="size-[0.34em] shrink-0 rounded-full bg-[oklch(0.55_0.15_145)]"
            />
            Understand
          </span>{" "}
          is the bottleneck.
        </h1>

        <p className="mt-6 max-w-xl text-balance text-lg leading-relaxed text-muted-foreground">
          Polymath turns everything entering your world — mail, files, pages,
          ideas — into an ordered, trustworthy plan, with the evidence intact.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-lg bg-primary px-6 py-3 text-[15px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get early access
          </Link>
          <Link
            href="/sign-in"
            className="rounded-lg border border-border px-6 py-3 text-[15px] font-medium transition-colors hover:border-foreground/40"
          >
            Sign in
          </Link>
        </div>
      </main>
    </div>
  );
}
