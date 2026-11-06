import type { StreamingSessionEvents, StreamingTranscriptionProvider } from "@/integrations/transcription/streaming";

/*
 * Framework-free dictation controller (issue #532): the per-prompt voice
 * button's brain, with the DOM kept behind FieldAdapter so the state machine
 * is unit-testable without a browser. Contracts the issue demands:
 *
 * - The button reflects mic state through every transition, including
 *   permission denial (getUserMedia rejections surface as "error", never a
 *   stuck "listening").
 * - Interim text replaces only the span this session owns; a final segment
 *   commits it. Typing anywhere else while dictating is never overwritten -
 *   the controller edits exactly [anchor, anchor + owned length), so text
 *   the user typed during recognition survives.
 * - Cancel discards the uncommitted interim; stop preserves trailing words
 *   (the provider flushes them as a trailing final before the mic releases).
 * - Mic tracks are stopped on stop, cancel and error - the browser's
 *   recording indicator never outlives the session.
 * - Undo removes the last committed span without touching anything else.
 */

/** The surface the controller edits. A textarea/input adapter ships below; tests use a fake. */
export interface FieldAdapter {
  /** Replace [start, end) with text and put the caret after the inserted text. */
  replaceRange(start: number, end: number, text: string): void;
  /** Current caret offset (collapsed) or the end of the active selection. */
  caretOffset(): number;
}

export type DictationState = "idle" | "requesting-mic" | "listening" | "error";

export type DictationControllerOptions = {
  provider: StreamingTranscriptionProvider;
  field: FieldAdapter;
  /** Injected for tests; production passes navigator.mediaDevices.getUserMedia.bind(...). */
  getUserMedia: (constraints: { audio: true }) => Promise<MediaStream>;
  onStateChange?: (state: DictationState, error?: Error) => void;
};

type CommittedSpan = { start: number; end: number };

export interface DictationController {
  state(): DictationState;
  /** Begin dictating: request the mic, open a streaming session, start inserting. */
  start(): Promise<void>;
  /** Stop and keep everything recognized, including trailing words. */
  stop(): Promise<void>;
  /** Stop and discard the uncommitted interim; committed text stays. */
  cancel(): Promise<void>;
  /** Remove the most recent committed span (the issue's undo-insertion affordance). */
  undoInsertion(): boolean;
}

export function createDictationController(options: DictationControllerOptions): DictationController {
  let state: DictationState = "idle";
  let stream: MediaStream | null = null;
  let session: { stop(): Promise<void>; cancel(): void } | null = null;
  /** Offset where the next dictated text goes; the span [anchor, anchor+interimLength) is ours. */
  let anchor = 0;
  let interimLength = 0;
  const committed: CommittedSpan[] = [];
  let cancelled = false;

  const setState = (next: DictationState, error?: Error) => {
    state = next;
    options.onStateChange?.(next, error);
  };

  const releaseMic = () => {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  };

  /** Replace only the owned interim span; text the user typed outside it is untouched. */
  const applyInterim = (text: string) => {
    options.field.replaceRange(anchor, anchor + interimLength, text);
    interimLength = text.length;
  };

  const applyFinal = (text: string, trailing: boolean) => {
    if (text.length === 0 && trailing) return;
    const from = anchor;
    const to = anchor + interimLength;
    const insert = trailing && text.length > 0 ? text : text;
    options.field.replaceRange(from, to, insert);
    interimLength = 0;
    anchor = from + insert.length;
    committed.push({ start: from, end: anchor });
  };

  const events: StreamingSessionEvents = {
    onInterim: (text) => {
      if (!cancelled) applyInterim(text);
    },
    onFinal: (segment) => {
      if (!cancelled) applyFinal(segment.text, segment.trailing);
    },
    onError: (error) => {
      releaseMic();
      session = null;
      setState("error", error);
    },
  };

  return {
    state: () => state,
    async start() {
      if (state === "requesting-mic" || state === "listening") return;
      cancelled = false;
      anchor = options.field.caretOffset();
      interimLength = 0;
      setState("requesting-mic");
      try {
        stream = await options.getUserMedia({ audio: true });
        session = await options.provider.startSession(events);
        setState("listening");
      } catch (error) {
        releaseMic();
        session = null;
        setState("error", error instanceof Error ? error : new Error(String(error)));
      }
    },
    async stop() {
      if (!session) {
        releaseMic();
        setState("idle");
        return;
      }
      const active = session;
      session = null;
      await active.stop(); // flushes trailing words as a final segment
      releaseMic();
      setState("idle");
    },
    async cancel() {
      cancelled = true;
      const active = session;
      session = null;
      if (active) active.cancel();
      // Discard the uncommitted interim only; committed spans stay.
      if (interimLength > 0) {
        options.field.replaceRange(anchor, anchor + interimLength, "");
        interimLength = 0;
      }
      releaseMic();
      setState("idle");
    },
    undoInsertion() {
      const last = committed.pop();
      if (!last) return false;
      options.field.replaceRange(last.start, last.end, "");
      anchor = last.start;
      return true;
    },
  };
}
