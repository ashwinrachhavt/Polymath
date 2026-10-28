import type { Metadata } from "next";
import Link from "next/link";

/*
 * The one public marketing route (GTM plan, funnel surface) and the page an
 * unauthenticated visitor lands on. Left-aligned hero after the mockup: the
 * highlighted word carries the claim, the features row answers "what is it"
 * in three cards, and every CTA is an app entry.
 */
export const metadata: Metadata = {
  title: "Polymath — Understand is the bottleneck",
  description:
    "Polymath turns everything entering your world — mail, files, pages, ideas — into an ordered, trustworthy plan.",
};

const features = [
  {
    n: "01",
    title: "The library",
    body: "Sources, notes, claims, cards, links, retrieval. Saved sources with retrieval beat ten tabs. The library is the asset.",
  },
  {
    n: "02",
    title: "The work",
    body: "Tasks, sessions, stones, areas. Commit to today, focus once, and let the record remember what earned what.",
  },
  {
    n: "03",
    title: "The agents",
    body: "A supervisor with durable runs. Agents propose; policy disposes. Nothing leaves until you approve the exact payload.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="polymath-mark size-7 text-[15px]">
            P
          </span>
          <span className="text-[15px] font-semibold">Polymath</span>
        </span>
        <Link
          href="/alfred"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Open the app
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6">
        <section className="flex flex-1 flex-col justify-center py-20">
          <h1 className="max-w-3xl text-[clamp(2.75rem,7vw,4.25rem)] font-bold leading-[1.05] tracking-[-0.02em]">
            <span className="inline-flex items-center rounded-[0.6em] bg-[oklch(0.93_0.05_150)] px-[0.32em] py-[0.04em] text-[oklch(0.27_0.008_75)]">
              Understand
            </span>{" "}
            is the bottleneck.
          </h1>

          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Polymath turns everything entering your world — mail, files, pages,
            ideas — into an ordered, trustworthy plan.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-up"
              className="rounded-lg bg-primary px-6 py-3 text-[15px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Get early access
            </Link>
            <Link
              href="/sign-in"
              className="rounded-lg border border-border bg-card px-6 py-3 text-[15px] font-medium transition-colors hover:bg-muted"
            >
              Sign in
            </Link>
          </div>
        </section>

        <section aria-label="What Polymath is" className="pb-24">
          <div className="panel grid overflow-hidden rounded-2xl sm:grid-cols-3">
            {features.map(({ n, title, body }) => (
              <article key={n} className="flex flex-col gap-3 border-border p-6 max-sm:border-b sm:max-[640px]:border-b sm:[&:not(:first-child)]:border-l max-sm:[&:not(:first-child)]:border-t">
                <span className="text-muted-foreground text-[13px]">{n}</span>
                <h2 className="text-[17px] font-semibold">{title}</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
