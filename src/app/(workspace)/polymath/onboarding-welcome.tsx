"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motionTransition } from "@/components/motion-config";

/*
 * The one-time welcome: what onboarding just learned, said back to the
 * person on the home they now land in — never a chat thread they did not
 * start. Rendered by the home in place of the greeting; the composer stays
 * below, because typing is still the shortest way in. The stamp (onShown)
 * fires once per mount and is idempotent server-side, so the welcome shows
 * exactly once and never again.
 */

export type OnboardingWelcomeData = {
  role: string | null;
  tools: string[];
  priorities: string[];
  /** The composed brief from a legacy session — the fallback voice when nothing structured was captured. */
  personifiedBrief: string | null;
  /** The welcome stamp, called once after the welcome has been shown. */
  onShown?: () => Promise<unknown> | void;
};

const FIRST_ACTIONS = [
  { href: "/polymath/notes", label: "Write your first note" },
  { href: "/command-center/inbox", label: "Capture something to your inbox" },
] as const;

export function OnboardingWelcome({ role, tools, priorities, personifiedBrief, onShown }: OnboardingWelcomeData) {
  const shownRef = useRef(false);
  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    void onShown?.();
  }, [onShown]);

  const knowsSomething = Boolean(role || tools.length || priorities.length);

  return (
    <motion.section
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTransition}
      aria-label="Welcome"
      className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 text-center"
    >
      <h1 className="screen-title">Your agent is ready.</h1>
      {knowsSomething ? (
        <div className="flex flex-col items-center gap-3">
          {role ? (
            <p className="screen-description">
              It knows you as <span className="font-medium text-foreground">{role}</span>.
            </p>
          ) : null}
          {tools.length ? (
            <ul aria-label="Your tools" className="flex flex-wrap justify-center gap-1.5">
              {tools.slice(0, 6).map((tool) => (
                <li
                  key={tool}
                  className="text-muted-foreground rounded-full border border-border px-2.5 py-0.5 text-label"
                >
                  {tool}
                </li>
              ))}
            </ul>
          ) : null}
          {priorities.length ? (
            <p className="text-muted-foreground max-w-xl text-body-dense leading-relaxed">
              Aiming first at: {priorities.slice(0, 3).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : personifiedBrief ? (
        <p className="screen-description">{personifiedBrief}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {FIRST_ACTIONS.map((action, index) => (
          <Button key={action.href} asChild variant={index === 0 ? "default" : "outline"}>
            <Link href={action.href}>
              {action.label}
              <ArrowRight aria-hidden data-icon="inline-end" />
            </Link>
          </Button>
        ))}
      </div>
      <p className="text-muted-foreground text-label">Or just start typing below — everything you give it shapes it.</p>
    </motion.section>
  );
}
