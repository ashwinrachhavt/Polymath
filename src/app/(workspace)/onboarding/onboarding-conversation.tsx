"use client";

import { useEffect, useRef, useState } from "react";
import { ChatSurface } from "@/components/chat/chat-surface";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { onboardingBriefAction, startOnboardingAction } from "./actions";
import { OnboardingConfirm } from "./onboarding-confirm";
import { OnboardingInterview } from "./onboarding-interview";

/*
 * The interview island. It owns the client-side lifecycle of the conversation:
 * start (or resume) the run, stream it on the shared ChatSurface, and swap to
 * the confirm card once the agent has emitted its brief.
 *
 * The brief is never trusted from the stream. The island polls the server
 * (onboardingBriefAction re-reads run_events), and the card renders only what
 * the server validated — a payload that lived only in the browser is not a
 * brief. Reload safety comes from the page above: it hands the open run's id
 * back in, and startOnboardingAction is resume-first even when it doesn't.
 */

export type OnboardingConversationProps = {
  /** An already-open interview run to resume; omitted starts a fresh one on mount. */
  initialRunId?: string;
};

export function OnboardingConversation({ initialRunId }: OnboardingConversationProps) {
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    brief: OnboardingBrief;
    profileVersion: number | null;
  } | null>(null);
  const [fallback, setFallback] = useState(false);
  const startedRef = useRef(false);

  // Start once per mount. The action is resume-first, so even a strict-mode
  // double effect converges on one run; the ref just saves the extra call.
  useEffect(() => {
    if (runId || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      const result = await startOnboardingAction();
      if (cancelled) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRunId(result.runId);
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Watch for the brief: while the conversation is open, ask the server every
  // few seconds whether the run's final turn produced one. The stream carries
  // the same text sooner, but the server read is the one the card may render
  // from — polling it directly keeps one source of truth.
  useEffect(() => {
    if (!runId || confirmed) return;
    let cancelled = false;
    const check = async () => {
      const result = await onboardingBriefAction(runId);
      if (cancelled || !result.ok) return;
      setConfirmed({ brief: result.brief, profileVersion: result.profileVersion });
    };
    const timer = window.setInterval(() => void check(), 4000);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId, confirmed]);

  if (fallback) {
    return <OnboardingInterview notice="The conversation could not continue. Answer the same four questions here — nothing you said is needed twice." />;
  }

  if (confirmed) {
    return (
      <OnboardingConfirm
        initial={confirmed.brief}
        profileVersion={confirmed.profileVersion}
        onBack={() => setConfirmed(null)}
      />
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium">The interview could not start</h1>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{error}</p>
        </header>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground"
            onClick={() => {
              setError(null);
              startedRef.current = false;
              setRunId(null);
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className="inline-flex min-h-9 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setFallback(true)}
          >
            Answer as a form instead
          </button>
        </div>
      </div>
    );
  }

  if (!runId) {
    return (
      <p role="status" className="text-muted-foreground text-[13px]">
        Starting the interview…
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Meet your agent</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Four quick questions, and your agent starts knowing who you are. It
          proposes what it heard for your confirmation before anything is saved.
        </p>
      </header>
      <ChatSurface
        runId={runId}
        subject={{ type: "artifact", id: runId }}
        title="Onboarding interview"
        placeholder="Answer to continue…"
        composerLabel="Your answer"
        emptyText="Your agent is saying hello…"
        showHeader={false}
        className="min-h-[320px] flex-1"
      />
    </div>
  );
}
