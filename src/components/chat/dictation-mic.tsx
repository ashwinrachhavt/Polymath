"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createDictationController,
  type DictationController,
  type DictationState,
  type FieldAdapter,
} from "@/lib/speech/dictation-controller";
import { apiDictationProvider } from "@/lib/speech/client-dictation";

/*
 * The composer's dictation affordance (issue #532): one mic button inside the
 * composer frame, next to send - the same surface, not a toolbar. The button
 * IS the mic state: idle invites, requesting-mic waits (disabled, so a double
 * click cannot open two sessions), listening pulses and a click stops (the
 * trailing words still land), error shows the reason and a click retries.
 * Escape while listening cancels: the uncommitted interim is removed and the
 * committed text stays.
 *
 * The textarea is React-controlled, so the adapter edits state, not the DOM:
 * replaceRange goes through setDraft and the caret is restored after the
 * render, which is what keeps dictation from fighting the controlled input.
 */

/** FieldAdapter over a React-controlled textarea: edits state, restores the caret post-render. */
export function useComposerFieldAdapter(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  setDraft: Dispatch<SetStateAction<string>>,
): FieldAdapter {
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && textareaRef.current) {
      const at = pendingCaret.current;
      pendingCaret.current = null;
      textareaRef.current.setSelectionRange(at, at);
    }
  });
  return useMemo<FieldAdapter>(
    () => ({
      replaceRange(start, end, text) {
        pendingCaret.current = start + text.length;
        setDraft((prev) => prev.slice(0, start) + text + prev.slice(end));
      },
      caretOffset() {
        return textareaRef.current?.selectionEnd ?? 0;
      },
    }),
    [setDraft, textareaRef],
  );
}

const STATE_LABEL: Record<DictationState, string> = {
  idle: "Dictate",
  "requesting-mic": "Requesting microphone",
  listening: "Stop dictation",
  error: "Dictation failed - retry",
};

export function DictationMicButton({ field }: { field: FieldAdapter }) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<DictationController | null>(null);

  const controller = () =>
    (controllerRef.current ??= createDictationController({
      provider: apiDictationProvider(),
      field,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      onStateChange: (next, cause) => {
        setState(next);
        setError(next === "error" ? (cause?.message ?? "Dictation failed.") : null);
      },
    }));

  // The mic never outlives the composer: unmount cancels the session.
  useEffect(
    () => () => {
      void controllerRef.current?.cancel();
    },
    [],
  );

  const clicked = () => {
    const active = controller();
    if (active.state() === "listening") void active.stop();
    else void active.start();
  };

  return (
    <span className="relative inline-flex">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={STATE_LABEL[state]}
        aria-pressed={state === "listening"}
        title={error ? `${STATE_LABEL[state]}: ${error}` : STATE_LABEL[state]}
        className="size-8 shrink-0 rounded-full"
        disabled={state === "requesting-mic"}
        onClick={clicked}
        onKeyDown={(event) => {
          if (event.key === "Escape" && state === "listening") {
            event.preventDefault();
            void controller().cancel();
          }
        }}
      >
        {state === "listening" ? (
          <MicOff aria-hidden className="size-4 text-destructive" />
        ) : (
          <Mic aria-hidden className="size-4" />
        )}
      </Button>
      {state === "listening" && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-destructive"
        />
      )}
    </span>
  );
}
