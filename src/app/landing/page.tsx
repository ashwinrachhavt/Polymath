import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { proxyArmed } from "@/lib/clerk";
import "./landing.css";

/*
 * The public front door: where a signed-out visitor lands (src/proxy.ts) and
 * the page the marketing link points at. It is static and ships no client
 * JavaScript of its own; the one interactive piece (the practice question) is
 * radio buttons and CSS.
 *
 * Every way in goes through the auth entries, because a static page cannot
 * know who is reading it: /sign-in and /sign-up show the form to a signed-out
 * visitor and send a signed-in one straight on (the proxy decides). Without
 * an armed proxy (keyless dev, the dev bypass) there are no auth pages and
 * the workspace is open, so the links go there directly.
 */
export const metadata: Metadata = {
  title: "Polymath: read it, prove it",
  description:
    "Everything you read or watch becomes knowledge you can prove you have. Polymath turns your own captures into a few minutes of practice a day.",
};

type SearchParams = Promise<{ returnTo?: string }>;
type Entry = "sign-in" | "sign-up";

/** A returnTo is usable only as a same-origin path: one leading slash, no protocol-relative "//". */
function safeReturnTo(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function entryHref(entry: Entry, returnTo: string | null): string {
  if (!proxyArmed) return returnTo ?? "/polymath";
  return returnTo ? `/${entry}?redirect_url=${encodeURIComponent(returnTo)}` : `/${entry}`;
}

async function ResolvedEntryLink({
  entry,
  searchParams,
  className,
  children,
}: {
  entry: Entry;
  searchParams: SearchParams;
  className: string;
  children: ReactNode;
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  return (
    <a href={entryHref(entry, returnTo)} className={className}>
      {children}
    </a>
  );
}

/**
 * A plain <a>, not next/link: every entry crosses into Clerk or the workspace,
 * where a full load is what both expect. The static shell carries the default
 * href; the returnTo a bounced deep link brings streams in right after.
 */
function EntryLink(props: { entry: Entry; searchParams: SearchParams; className: string; children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <a href={entryHref(props.entry, null)} className={props.className}>
          {props.children}
        </a>
      }
    >
      <ResolvedEntryLink {...props} />
    </Suspense>
  );
}

const stages = [
  { id: "capture", when: "One click", text: "First, save a page, a PDF, a video or a note." },
  {
    id: "absorb",
    when: "As long as the read",
    text: "Then read it with Polymath, which explains it and links it to what you already know.",
  },
  {
    id: "practice",
    when: "Five minutes a day",
    text: "Each day, answer a few questions written from your own captures.",
  },
  {
    id: "prove",
    when: "On the day it counts",
    text: "Then prove it: a Mission tests you before the date that matters.",
  },
];

const report = [
  { concept: "Consistent hashing", verdict: "Proven" },
  { concept: "Caching strategies", verdict: "Proven" },
  { concept: "Rate limiting", verdict: "Partial" },
  { concept: "Leader election", verdict: "Gap" },
];

const faqs = [
  {
    q: "Who is Polymath for?",
    a: "Anyone learning something for real: an engineer moving into a new field, someone working alongside AI agents, a student with an exam date. There is nothing technical to set up.",
  },
  {
    q: "What can I save?",
    a: "Web pages, PDFs, YouTube videos and your own notes. Each one becomes material for questions, with the passage it came from kept beside it.",
  },
  {
    q: "Where do the questions come from?",
    a: "From what you saved. Polymath writes them from your own sources, shows the passage behind every answer, and brings back the ones you missed until they stick.",
  },
  {
    q: "What is a Mission?",
    a: "A goal with a date and the sources that cover it. You explain each concept, sit a mock interview, and get a readiness report that says ready only when every concept is proven.",
  },
  {
    q: "Why is it invite only?",
    a: "We are opening slowly so the hosted models stay affordable and every early user gets a good first week. If your address is on the list, signing up works today.",
  },
  {
    q: "Can I use my own AI key?",
    a: "Soon. With your own key Polymath stays free and everything is unlocked; you pay your provider directly. Pro, at $10 a month, will be for people who would rather we run the models.",
  },
];

export default function LandingPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="lp">
      <header className="lp-nav lp-frame">
        <a href="#top" className="lp-wordmark">
          Polymath
        </a>
        <nav aria-label="On this page" className="lp-nav-links">
          <a href="#how">How it works</a>
          <a href="#agents">For agent users</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <EntryLink entry="sign-in" searchParams={searchParams} className="lp-button lp-button-small">
          Open the app
        </EntryLink>
      </header>

      <main id="top">
        <section className="lp-hero lp-frame" aria-labelledby="hero-title">
          <h1 id="hero-title" className="lp-hero-title">
            <span className="lp-hero-line">
              Read it.
              <span className="lp-slot" aria-hidden="true" data-ui>
                <span className="lp-slot-shutter">
                  <span className="lp-slot-face lp-slot-saved">
                    <span className="lp-slot-meta">Saved from arxiv.org</span>
                    <span className="lp-slot-main">Attention Is All You Need</span>
                    <span className="lp-slot-meta">12-minute read</span>
                  </span>
                  <span className="lp-slot-face lp-slot-asked">
                    <span className="lp-slot-meta">Today, question 1 of 5</span>
                    <span className="lp-slot-main">Why does attention get expensive on long inputs?</span>
                  </span>
                </span>
              </span>
            </span>{" "}
            <span className="lp-hero-line">Prove it.</span>
          </h1>
          <div className="lp-hero-foot">
            <p className="lp-lead">
              Everything you read or watch becomes knowledge you can prove you have. Polymath turns your own captures
              into a few minutes of practice a day.
            </p>
            <div className="lp-hero-action">
              <EntryLink entry="sign-up" searchParams={searchParams} className="lp-button">
                Get started
              </EntryLink>
              <p className="lp-note">Free, and invite only for now.</p>
            </div>
          </div>
        </section>

        <section id="how" className="lp-section lp-frame" aria-labelledby="how-title">
          <h2 id="how-title" className="lp-heading lp-rise">
            How it sticks
          </h2>
          <ol className="lp-bar" data-ui>
            {stages.map((stage) => (
              <li key={stage.id} className={`lp-stage lp-stage-${stage.id} lp-rise`}>
                <span className="lp-stage-block">
                  <span className="lp-stage-when">{stage.when}</span>
                </span>
                <span className="lp-stage-text">{stage.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-section lp-frame lp-split" aria-labelledby="practice-title">
          <div className="lp-split-text">
            <h2 id="practice-title" className="lp-heading lp-heading-md lp-rise">
              Five minutes a day
            </h2>
            <p className="lp-body lp-rise">
              Each morning Polymath asks a few questions written from what you saved, shows the passage behind every
              answer, and brings back the ones you missed until they stick. Try one.
            </p>
          </div>
          <div className="lp-quiz lp-rise" data-ui>
            <p className="lp-quiz-meta">From “Attention Is All You Need”, saved yesterday</p>
            <fieldset>
              <legend id="quiz-q" className="lp-quiz-q">
                Why does self-attention get expensive on long inputs?
              </legend>
              <label className="lp-option">
                <input type="radio" name="answer" value="right" />
                <span>
                  Every token is compared with every other token, so the work grows with the square of the length.
                </span>
              </label>
              <label className="lp-option">
                <input type="radio" name="answer" value="wrong-a" />
                <span>Each token has to wait for the one before it, as in a recurrent network.</span>
              </label>
              <label className="lp-option">
                <input type="radio" name="answer" value="wrong-b" />
                <span>The vocabulary grows with the length of the input.</span>
              </label>
            </fieldset>
            <p className="lp-feedback lp-feedback-right">
              Right. Doubling the input quadruples the comparisons. This one comes back in four days.
            </p>
            <p className="lp-feedback lp-feedback-wrong">
              Not quite. Self-attention compares every token with every other one, so doubling the input quadruples the
              work. This one comes back tomorrow.
            </p>
          </div>
        </section>

        <section id="agents" className="lp-section lp-agents" aria-labelledby="agents-title">
          <div className="lp-frame lp-agents-top">
            <h2 id="agents-title" className="lp-heading lp-heading-md lp-rise">
              Understand what your agent built
            </h2>
            <p className="lp-body lp-rise">
              Claude Code and Codex now write more than anyone can read. The Polymath plugin for Claude Code explains a
              change in plain words, asks you five questions about it, and turns what you miss into tomorrow’s practice.
              Coming soon.
            </p>
          </div>
          <div
            className="lp-specimens"
            aria-label="Example: the agent wrote 412 lines; you could answer 3 of 5 questions about them"
          >
            <figure className="lp-specimen">
              <span aria-hidden="true">+412</span>
              <figcaption>Lines your agent wrote today</figcaption>
            </figure>
            <figure className="lp-specimen lp-specimen-inverse">
              <span aria-hidden="true">3/5</span>
              <figcaption>Questions you could answer about them</figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-section lp-frame lp-split lp-split-mirror" aria-labelledby="missions-title">
          <div className="lp-report lp-rise" data-ui>
            <p className="lp-report-head">
              <span>Mission: systems design interview</span>
              <span>December 4</span>
            </p>
            <ul>
              {report.map((row) => (
                <li key={row.concept} className={`lp-report-row lp-verdict-${row.verdict.toLowerCase()}`}>
                  <span>{row.concept}</span>
                  <span className="lp-report-verdict">{row.verdict}</span>
                </li>
              ))}
            </ul>
            <p className="lp-report-overall">
              Not ready yet. Work on rate limiting and leader election before the date.
            </p>
          </div>
          <div className="lp-split-text">
            <h2 id="missions-title" className="lp-heading lp-heading-md lp-rise">
              Know you’re ready before the day
            </h2>
            <p className="lp-body lp-rise">
              A Mission is a goal with a date and the sources that cover it. You explain each concept in your own words,
              sit a mock interview, and get a readiness report. It says ready only when every concept is proven.
            </p>
          </div>
        </section>

        <section id="pricing" className="lp-pricing" aria-labelledby="pricing-title">
          <div className="lp-frame">
            <h2 id="pricing-title" className="lp-heading lp-pricing-title lp-rise">
              Free, or <span className="lp-price">$10</span> a month.
            </h2>
            <div className="lp-pricing-foot">
              <ul className="lp-plans lp-rise">
                <li>
                  <strong>Free</strong>
                  <span>Open now, by invitation. Everything you see on this page.</span>
                </li>
                <li>
                  <strong>Your own key</strong>
                  <span>
                    Coming soon. Bring an AI provider key; everything is unlocked and you pay the provider directly.
                  </span>
                </li>
                <li>
                  <strong>Pro, $10 a month</strong>
                  <span>Coming soon. We run the models for you, nothing to set up.</span>
                </li>
              </ul>
              <EntryLink entry="sign-up" searchParams={searchParams} className="lp-button lp-rise">
                Get started free
              </EntryLink>
            </div>
          </div>
        </section>

        <section id="faq" className="lp-section lp-frame lp-faq" aria-labelledby="faq-title">
          <h2 id="faq-title" className="lp-heading lp-rise">
            Questions, answered
          </h2>
          <div className="lp-faq-list">
            {faqs.map(({ q, a }) => (
              <details key={q} className="lp-faq-item">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-frame lp-footer-top">
          <div>
            <p className="lp-footer-invite">Start with something you read today.</p>
            <EntryLink entry="sign-up" searchParams={searchParams} className="lp-button lp-button-inverse">
              Get started
            </EntryLink>
          </div>
          <nav aria-label="Footer" className="lp-footer-links">
            <EntryLink entry="sign-in" searchParams={searchParams} className="">
              Sign in
            </EntryLink>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
        </div>
        <p className="lp-frame lp-legal">
          <span>© 2026 Polymath</span>
          <span>Invite only during early access</span>
        </p>
        <p className="lp-footer-name" aria-hidden="true">
          Polymath
        </p>
      </footer>
    </div>
  );
}
