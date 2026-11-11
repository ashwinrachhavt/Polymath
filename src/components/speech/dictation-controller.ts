import {
  IDLE,
  transition,
  type DictationEffect,
  type DictationEvent,
  type DictationState,
  type FailureReason,
} from "./dictation-machine";
import { DICTATED_EVENT, editableTarget, insertDictation, type DictationTarget } from "./dictation-target";
import { startRecorder, type Recorder } from "./recorder";

/*
 * The one dictation controller for the page. It owns the side of dictation the
 * machine cannot: the key listener, the recorder, uploads and the field the
 * words go into. All lifecycle decisions are the machine's (dictation-machine.ts).
 *
 * Right Option (AltRight) alone is the key. Recording starts on keydown so the
 * first word is not lost; any other key while it is down makes it a shortcut
 * or an AltGr character, and that audio is thrown away unsent.
 *
 * The module-level functions are the API other UI calls (mic buttons):
 * startDictation, stopDictation, subscribe, getDictationState and
 * getDictationTarget.
 */

const TRANSCRIPTIONS_URL = "/api/v1/speech/transcriptions";
const SESSION_MAX_MS = 10 * 60_000;
const NO_FIELD_HINT_MS = 2_500;

let state: DictationState = IDLE;
const listeners = new Set<() => void>();

/** The field focused when the session started; text goes here even if focus moves on. */
let target: DictationTarget | null = null;
/** The contenteditable target's last caret, since its selection is lost when focus leaves. */
let savedRange: Range | null = null;
let recorder: Recorder | null = null;
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let nextClipId = 1;
/** AltRight is physically down and was pressed alone. */
let triggerDown = false;

export function getDictationState(): DictationState {
  return state;
}

/** The field the current session's words go into; null while idle. */
export function getDictationTarget(): DictationTarget | null {
  return target;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dispatch(event: DictationEvent): void {
  const step = transition(state, event);
  state = step.state;
  if (state.kind === "idle") {
    target = null;
    savedRange = null;
    clearTimeout(sessionTimer);
  }
  clearTimeout(hintTimer);
  if (state.kind === "idle" && state.notice?.kind === "no-field") {
    hintTimer = setTimeout(() => dispatch({ type: "dismiss" }), NO_FIELD_HINT_MS);
  }
  step.effects.forEach(perform);
  listeners.forEach((listener) => listener());
}

function perform(effect: DictationEffect): void {
  switch (effect.type) {
    case "start-recording": {
      const own: Recorder = startRecorder({
        onStart: () => {
          if (recorder === own) dispatch({ type: "micOpened" });
        },
        onClip: (audio, final) => {
          if (recorder !== own) return;
          if (final) recorder = null;
          dispatch({ type: "clipReady", clip: audio ? { id: nextClipId++, audio } : null, final });
        },
        onError: (reason) => {
          if (recorder !== own) return;
          recorder = null;
          dispatch({ type: "recorderFailed", reason });
        },
      });
      recorder = own;
      sessionTimer = setTimeout(() => dispatch({ type: "maxDuration" }), SESSION_MAX_MS);
      return;
    }
    case "stop-recording":
      clearTimeout(sessionTimer);
      recorder?.stop();
      return;
    case "discard-recording":
      clearTimeout(sessionTimer);
      recorder?.discard();
      recorder = null;
      return;
    case "transcribe":
      void transcribe(effect.clip.id, effect.clip.audio);
      return;
  }
}

const isHead = (clipId: number) => state.kind !== "idle" && state.session.queue[0]?.id === clipId;

function failureFor(status: number): FailureReason {
  if (status === 503) return "unconfigured";
  if (status === 429) return "exhausted";
  return "failed";
}

async function transcribe(clipId: number, audio: Blob): Promise<void> {
  let outcome: { text: string } | { reason: FailureReason };
  try {
    const response = await fetch(TRANSCRIPTIONS_URL, { method: "POST", body: audio });
    if (response.ok) {
      const body: unknown = await response.json();
      const text = typeof body === "object" && body !== null && "text" in body ? body.text : null;
      outcome = typeof text === "string" ? { text } : { reason: "failed" };
    } else {
      outcome = { reason: failureFor(response.status) };
    }
  } catch {
    outcome = { reason: "failed" };
  }
  // Cancelled, dismissed, or superseded by a retry while this was in flight.
  if (!isHead(clipId)) return;
  if ("reason" in outcome) return dispatch({ type: "clipFailed", clipId, reason: outcome.reason });
  const text = outcome.text.trim();
  const delivered = !text || (target !== null && insertDictation(target, text, savedRange) === "inserted");
  if (text && delivered) target?.dispatchEvent(new CustomEvent(DICTATED_EVENT));
  dispatch({ type: "clipTranscribed", clipId, stranded: delivered ? "" : text });
}

function caretIn(element: DictationTarget): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return element.contains(range.startContainer) ? range.cloneRange() : null;
}

function begin(type: "keyDown" | "toggle", at: number, candidate: Element | null): void {
  if (state.kind === "idle") {
    target = editableTarget(candidate);
    savedRange = target ? caretIn(target) : null;
    dispatch({ type, at, hasTarget: target !== null });
    return;
  }
  dispatch({ type, at, hasTarget: true });
}

/** Turn dictation on into `field` (default: the focused element), latched until stopped. */
export function startDictation(field?: Element): void {
  if (state.kind === "idle") begin("toggle", performance.now(), field ?? document.activeElement);
}

/** Stop listening; recorded audio is still transcribed and inserted. */
export function stopDictation(): void {
  if (state.kind === "listening") dispatch({ type: "toggle", at: performance.now(), hasTarget: true });
}

export function cancelDictation(): void {
  if (state.kind !== "idle" || state.notice) dispatch({ type: "cancel" });
}

export function retryDictation(): void {
  dispatch({ type: "retry" });
}

export function dismissDictation(): void {
  dispatch({ type: "dismiss" });
}

export function handleKeyDown(event: KeyboardEvent): void {
  // AltGraph is the key's own name where it types characters (non-US layouts on Windows/Linux).
  if (event.code === "AltRight" && event.key !== "AltGraph") {
    if (event.repeat) return;
    triggerDown = !(event.ctrlKey || event.metaKey || event.shiftKey);
    if (triggerDown) begin("keyDown", event.timeStamp, document.activeElement);
    return;
  }
  if (event.key === "Escape" && state.kind !== "idle") {
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "cancel" });
    return;
  }
  if (triggerDown) dispatch({ type: "otherKey" });
}

export function handleKeyUp(event: KeyboardEvent): void {
  if (event.code !== "AltRight" || !triggerDown) return;
  triggerDown = false;
  dispatch({ type: "keyUp", at: event.timeStamp });
}

/**
 * Attach the page-wide listeners. `early` are AltRight events that arrived
 * before this module loaded; they are replayed so a press during load counts.
 */
export function installDictation(early: KeyboardEvent[] = []): () => void {
  const onBlur = () => {
    // The key-up goes to another window, so the release is now.
    if (!triggerDown) return;
    triggerDown = false;
    dispatch({ type: "keyUp", at: performance.now() });
  };
  const onSelectionChange = () => {
    if (target && !(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
      savedRange = caretIn(target) ?? savedRange;
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("keyup", handleKeyUp, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", cancelDictation);
  document.addEventListener("selectionchange", onSelectionChange);
  for (const event of early) (event.type === "keydown" ? handleKeyDown : handleKeyUp)(event);
  return () => {
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", cancelDictation);
    document.removeEventListener("selectionchange", onSelectionChange);
    cancelDictation();
  };
}
