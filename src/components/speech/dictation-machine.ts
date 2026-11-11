/*
 * The whole dictation lifecycle as one pure transition function: no DOM, no
 * timers, no network. The controller feeds it events (keys, recorder output,
 * server answers) and performs the effects it returns, so every rule about
 * when audio is kept, sent, inserted or thrown away lives here and is tested
 * here.
 *
 * Clips are transcribed one at a time, oldest first: the head of the queue is
 * the one in flight. Text is inserted by the controller before it reports a
 * clip transcribed, so insertion order is queue order.
 */

/** Held at least this long, the key is push-to-talk; released sooner, it latches. */
export const HOLD_THRESHOLD_MS = 300;

export type Clip = { id: number; audio: Blob };

export type FailureReason = "permission" | "no-microphone" | "unsupported" | "unconfigured" | "exhausted" | "failed";

type Session = {
  /** Recorded clips not yet inserted, oldest first; the head is being transcribed. */
  queue: readonly Clip[];
  /** The recorder is running, or stopping and its last clip has not arrived. */
  recording: boolean;
  /** Text whose field left the page; offered for copying when the session ends. */
  stranded: string;
};

/**
 * held: the key is down and it is not yet known whether this is a hold or a tap.
 * latched: a tap turned listening on; the next tap stops it.
 * latched-pressed: latched, and the key is down again (a stop, unless another key joins it).
 */
type Press = { kind: "held"; since: number } | { kind: "latched" } | { kind: "latched-pressed" };

type Notice = { kind: "no-field" } | { kind: "stranded"; text: string };

export type DictationState =
  | { kind: "idle"; notice: Notice | null }
  | {
      kind: "listening";
      press: Press;
      startedAt: number;
      /** The microphone has opened; until then nothing said is being captured. */
      micOpen: boolean;
      session: Session;
    }
  | { kind: "transcribing"; session: Session }
  | { kind: "error"; reason: FailureReason; failed: Clip | null; session: Session };

export type DictationEvent =
  | { type: "keyDown"; at: number; hasTarget: boolean }
  | { type: "keyUp"; at: number }
  | { type: "otherKey" }
  | { type: "toggle"; at: number; hasTarget: boolean }
  | { type: "maxDuration" }
  | { type: "micOpened" }
  | { type: "clipReady"; clip: Clip | null; final: boolean }
  | { type: "clipTranscribed"; clipId: number; stranded: string }
  | { type: "clipFailed"; clipId: number; reason: FailureReason }
  | { type: "recorderFailed"; reason: FailureReason }
  | { type: "cancel" }
  | { type: "retry" }
  | { type: "dismiss" };

export type DictationEffect =
  | { type: "start-recording" }
  | { type: "stop-recording" }
  | { type: "discard-recording" }
  | { type: "transcribe"; clip: Clip };

type Step = { state: DictationState; effects: DictationEffect[] };

export const IDLE: DictationState = { kind: "idle", notice: null };

const stay = (state: DictationState): Step => ({ state, effects: [] });

function begin(press: Press, at: number): Step {
  return {
    state: {
      kind: "listening",
      press,
      startedAt: at,
      micOpen: false,
      session: { queue: [], recording: true, stranded: "" },
    },
    effects: [{ type: "start-recording" }],
  };
}

/** A session with nothing recording and nothing queued is over. */
function settle(session: Session, effects: DictationEffect[]): Step {
  if (session.recording || session.queue.length > 0) return { state: { kind: "transcribing", session }, effects };
  const notice: Notice | null = session.stranded ? { kind: "stranded", text: session.stranded } : null;
  return { state: { kind: "idle", notice }, effects };
}

function stop(session: Session): Step {
  return { state: { kind: "transcribing", session }, effects: [{ type: "stop-recording" }] };
}

function abandon(session: Session): Step {
  return { state: IDLE, effects: session.recording ? [{ type: "discard-recording" }] : [] };
}

const joinText = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

export function transition(state: DictationState, event: DictationEvent): Step {
  switch (event.type) {
    case "keyDown":
      if (state.kind === "idle") {
        return event.hasTarget
          ? begin({ kind: "held", since: event.at }, event.at)
          : stay({ kind: "idle", notice: { kind: "no-field" } });
      }
      if (state.kind === "listening" && state.press.kind === "latched") {
        return stay({ ...state, press: { kind: "latched-pressed" } });
      }
      return stay(state);

    case "keyUp":
      if (state.kind !== "listening") return stay(state);
      if (state.press.kind === "held") {
        return event.at - state.press.since >= HOLD_THRESHOLD_MS
          ? stop(state.session)
          : stay({ ...state, press: { kind: "latched" } });
      }
      if (state.press.kind === "latched-pressed") return stop(state.session);
      return stay(state);

    case "otherKey":
      // A combination such as Alt+Arrow or an AltGr character, not dictation.
      if (state.kind !== "listening") return stay(state);
      if (state.press.kind === "held") return abandon(state.session);
      if (state.press.kind === "latched-pressed") return stay({ ...state, press: { kind: "latched" } });
      return stay(state);

    case "toggle":
      if (state.kind === "idle") {
        return event.hasTarget
          ? begin({ kind: "latched" }, event.at)
          : stay({ kind: "idle", notice: { kind: "no-field" } });
      }
      if (state.kind === "listening") return stop(state.session);
      return stay(state);

    case "maxDuration":
      return state.kind === "listening" ? stop(state.session) : stay(state);

    case "micOpened":
      return state.kind === "listening" ? stay({ ...state, micOpen: true }) : stay(state);

    case "clipReady": {
      if (state.kind === "idle") return stay(state);
      const { clip, final } = event;
      const queue = clip ? [...state.session.queue, clip] : state.session.queue;
      const session: Session = { ...state.session, queue, recording: state.session.recording && !final };
      if (state.kind === "error") return stay({ ...state, session });
      const effects: DictationEffect[] = clip && state.session.queue.length === 0 ? [{ type: "transcribe", clip }] : [];
      if (state.kind === "listening" && session.recording) return { state: { ...state, session }, effects };
      return settle(session, effects);
    }

    case "clipTranscribed": {
      if (state.kind === "idle" || state.session.queue[0]?.id !== event.clipId) return stay(state);
      const [, ...rest] = state.session.queue;
      const session: Session = {
        ...state.session,
        queue: rest,
        stranded: joinText(state.session.stranded, event.stranded),
      };
      if (state.kind === "error") return stay({ ...state, session });
      const effects: DictationEffect[] = rest[0] ? [{ type: "transcribe", clip: rest[0] }] : [];
      if (state.kind === "listening") return { state: { ...state, session }, effects };
      return settle(session, effects);
    }

    case "clipFailed": {
      if (
        (state.kind !== "listening" && state.kind !== "transcribing") ||
        state.session.queue[0]?.id !== event.clipId
      ) {
        return stay(state);
      }
      const [failed, ...rest] = state.session.queue;
      const session: Session = { ...state.session, queue: rest };
      // The rest of the recording is kept behind the failed clip for Retry,
      // but a provider that just refused will refuse again: stop listening.
      return {
        state: { kind: "error", reason: event.reason, failed, session },
        effects: state.kind === "listening" ? [{ type: "stop-recording" }] : [],
      };
    }

    case "recorderFailed":
      if (state.kind !== "listening") return stay(state);
      return stay({
        kind: "error",
        reason: event.reason,
        failed: null,
        session: { ...state.session, recording: false },
      });

    case "retry": {
      if (state.kind !== "error") return stay(state);
      const queue = state.failed ? [state.failed, ...state.session.queue] : state.session.queue;
      if (queue.length === 0) return stay(state);
      return {
        state: { kind: "transcribing", session: { ...state.session, queue } },
        effects: [{ type: "transcribe", clip: queue[0] }],
      };
    }

    case "cancel":
    case "dismiss":
      return state.kind === "idle" ? stay(IDLE) : abandon(state.session);
  }
}
