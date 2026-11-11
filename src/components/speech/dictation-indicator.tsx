"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IDLE, type DictationState, type FailureReason } from "./dictation-machine";
import { dismissDictation, getDictationState, retryDictation, stopDictation, subscribe } from "./dictation-controller";

/*
 * The one visible sign of dictation: a small pill at the top centre that
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
    // Hidden from the live region: a status is read whole on every change, so a
    // ticking second would talk over the person, into their own microphone.
    <span aria-hidden className="readout tabular-nums text-muted-foreground">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [failed, setFailed] = useState(false);
  // The clipboard can be missing (insecure context) or refuse; the words then
  // stay on screen, selectable, instead of vanishing behind a dead button.
  const copy = () =>
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(dismissDictation, () => setFailed(true));
  return (
    <Button size="xs" variant="outline" onClick={copy}>
      {failed ? "Copy failed - select the text" : "Copy"}
    </Button>
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
              <span data-selectable className="line-clamp-2 select-text text-muted-foreground">
                {text}
              </span>
            </span>
            <CopyButton text={text} />
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
          <span className="hidden whitespace-nowrap text-muted-foreground sm:inline">
            {state.press.kind === "held" ? "Release Right Option to insert" : "Tap Right Option to stop"}
          </span>
          {state.press.kind === "held" ? null : (
            <Button size="xs" variant="outline" onClick={stopDictation}>
              Stop
            </Button>
          )}
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
  const pill = useRef<HTMLDivElement>(null);

  // A modal dialog closes on any pointer press outside it, which it detects
  // on the document. Dictation runs inside dialogs too (the capture dialog),
  // so presses on the pill stop here and Retry does not close the dialog
  // the words are meant for.
  useEffect(() => {
    const element = pill.current;
    if (!element) return;
    const contain = (event: PointerEvent) => event.stopPropagation();
    element.addEventListener("pointerdown", contain);
    return () => element.removeEventListener("pointerdown", contain);
  }, []);

  // On the body and above the dialog layer, with pointer events restored: an
  // open modal turns them off for everything outside it and paints its
  // overlay over the page. At the top, because the bottom of the screen is
  // where the composer, the mobile nav and the on-screen keyboard are.
  return createPortal(
    <div
      ref={pill}
      role="status"
      aria-live="polite"
      aria-label="Dictation"
      data-dictation={state.kind}
      // The field keeps its focus and caret while the pill's buttons are used;
      // stranded words stay selectable by hand.
      onMouseDown={(event) => {
        if (!(event.target instanceof Element && event.target.closest("[data-selectable]"))) event.preventDefault();
      }}
      className={
        visible
          ? "panel pointer-events-auto fixed top-3 left-1/2 z-[60] flex max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-2xl px-4 py-2 text-body-dense"
          : "sr-only"
      }
    >
      <Content state={state} />
    </div>,
    document.body,
  );
}
