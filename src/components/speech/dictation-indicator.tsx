"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IDLE, type DictationState, type FailureReason } from "./dictation-machine";
import { dismissDictation, getDictationState, retryDictation, subscribe } from "./dictation-controller";

/*
 * The one visible sign of dictation: a small pill at the bottom centre that
 * says whether the microphone is on, what is being transcribed, and what went
 * wrong. It renders nothing while dictation is idle and has nothing to say.
 */

const FAILURE_MESSAGES: Record<FailureReason, string> = {
  permission: "Microphone access is blocked. Allow it for this site in the browser, then try again.",
  "no-microphone": "No microphone was found.",
  unsupported: "This browser cannot record audio.",
  unconfigured: "Dictation is not set up on this deployment.",
  exhausted: "The transcription allowance is used up.",
  failed: "Transcription failed. The recording is kept here until you retry or dismiss it.",
};

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className="readout tabular-nums text-muted-foreground">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

function Content({ state }: { state: DictationState }) {
  switch (state.kind) {
    case "idle":
      if (state.notice?.kind === "no-field") return <span>Click into a text field first</span>;
      if (state.notice?.kind === "stranded") {
        const text = state.notice.text;
        return (
          <>
            <span className="min-w-0">
              The field closed before your words arrived:{" "}
              <span className="line-clamp-2 text-muted-foreground">{text}</span>
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(text).then(dismissDictation)}
            >
              Copy
            </Button>
            <Button size="xs" variant="ghost" onClick={dismissDictation}>
              Dismiss
            </Button>
          </>
        );
      }
      return null;
    case "listening":
      if (!state.micOpen) return <span>Starting the microphone…</span>;
      return (
        <>
          <Mic aria-hidden className="size-4 shrink-0 text-destructive motion-safe:animate-pulse" />
          <span>Listening</span>
          <Elapsed key={state.startedAt} startedAt={state.startedAt} />
          <span className="text-muted-foreground">
            {state.press.kind === "held" ? "Release Right Option to insert" : "Tap Right Option to stop"}
          </span>
        </>
      );
    case "transcribing":
      return <span>Transcribing…</span>;
    case "error": {
      const canRetry = state.failed !== null || state.session.queue.length > 0;
      return (
        <>
          <span className="min-w-0">{FAILURE_MESSAGES[state.reason]}</span>
          {canRetry ? (
            <Button size="xs" variant="outline" onClick={retryDictation}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={dismissDictation}>
            Dismiss
          </Button>
        </>
      );
    }
  }
}

export function DictationIndicator() {
  const state = useSyncExternalStore(subscribe, getDictationState, () => IDLE);
  const visible = state.kind !== "idle" || state.notice !== null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Dictation"
      data-dictation={state.kind}
      className={
        visible
          ? "panel fixed bottom-20 left-1/2 z-50 flex max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-2xl px-4 py-2 text-body-dense md:bottom-4"
          : "sr-only"
      }
    >
      <Content state={state} />
    </div>
  );
}
