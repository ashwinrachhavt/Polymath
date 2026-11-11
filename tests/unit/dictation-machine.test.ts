import { describe, expect, it } from "vitest";
import {
  HOLD_THRESHOLD_MS,
  IDLE,
  transition,
  type Clip,
  type DictationEvent,
  type DictationState,
} from "@/components/speech/dictation-machine";

/*
 * Value: protects=every dictation lifecycle rule: when the microphone starts and stops, which clips
 * are sent, in what order, and when audio is thrown away; fails_when=a combination such as Alt+Arrow
 * records or sends audio, a tap does not latch, Escape lets a late answer through, a failed clip is
 * lost instead of kept for retry, or clips are sent out of order; why_new=the machine is new;
 * seam=transition() is the whole public contract; no_claim=the DOM recorder, uploads and insertion
 * (the e2e spec covers those)
 */

const clip = (id: number): Clip => ({ id, audio: new Blob([`clip-${id}`], { type: "audio/webm" }) });

function run(events: DictationEvent[], from: DictationState = IDLE) {
  let state = from;
  const effects: unknown[] = [];
  for (const event of events) {
    const step = transition(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const press = (at = 0): DictationEvent => ({ type: "keyDown", at, hasTarget: true });
const release = (at: number): DictationEvent => ({ type: "keyUp", at });

describe("starting", () => {
  it("starts recording on key down with a field focused", () => {
    const { state, effects } = run([press(10)]);
    expect(state).toMatchObject({ kind: "listening", press: { kind: "held", since: 10 }, startedAt: 10 });
    expect(effects).toEqual([{ type: "start-recording" }]);
  });

  it("says listening only once the microphone has opened", () => {
    const starting = run([press(10)]).state;
    expect(starting).toMatchObject({ kind: "listening", micOpen: false });
    expect(run([{ type: "micOpened" }], starting).state).toMatchObject({ kind: "listening", micOpen: true });
    const transcribing = run([release(400)], starting).state;
    expect(run([{ type: "micOpened" }], transcribing).state).toBe(transcribing);
  });

  it("does not record without a field; it shows the hint", () => {
    const { state, effects } = run([{ type: "keyDown", at: 0, hasTarget: false }]);
    expect(state).toEqual({ kind: "idle", notice: { kind: "no-field" } });
    expect(effects).toEqual([]);
  });

  it("toggle starts latched", () => {
    const { state, effects } = run([{ type: "toggle", at: 5, hasTarget: true }]);
    expect(state).toMatchObject({ kind: "listening", press: { kind: "latched" } });
    expect(effects).toEqual([{ type: "start-recording" }]);
  });

  it("ignores the key while a previous session is transcribing", () => {
    const transcribing = run([press(0), release(HOLD_THRESHOLD_MS)]).state;
    expect(run([press(1000)], transcribing)).toEqual({ state: transcribing, effects: [] });
  });
});

describe("hold versus tap", () => {
  it("a hold of at least the threshold is push-to-talk: release stops", () => {
    const { state, effects } = run([press(0), release(HOLD_THRESHOLD_MS)]);
    expect(state).toMatchObject({ kind: "transcribing", session: { recording: true, queue: [] } });
    expect(effects).toEqual([{ type: "start-recording" }, { type: "stop-recording" }]);
  });

  it("a shorter press latches; the next tap stops", () => {
    const latched = run([press(0), release(HOLD_THRESHOLD_MS - 1)]);
    expect(latched.state).toMatchObject({ kind: "listening", press: { kind: "latched" } });
    expect(latched.effects).toEqual([{ type: "start-recording" }]);
    const pressedAgain = run([press(5000)], latched.state);
    expect(pressedAgain.state).toMatchObject({ kind: "listening", press: { kind: "latched-pressed" } });
    expect(pressedAgain.effects).toEqual([]);
    const stopped = run([release(5050)], pressedAgain.state);
    expect(stopped.state.kind).toBe("transcribing");
    expect(stopped.effects).toEqual([{ type: "stop-recording" }]);
  });

  it("toggle stops a latched session", () => {
    const { state, effects } = run([
      { type: "toggle", at: 0, hasTarget: true },
      { type: "toggle", at: 9, hasTarget: true },
    ]);
    expect(state.kind).toBe("transcribing");
    expect(effects).toEqual([{ type: "start-recording" }, { type: "stop-recording" }]);
  });

  it("the ten-minute ceiling stops a session like a release", () => {
    const { state, effects } = run([press(0), release(10), { type: "maxDuration" }]);
    expect(state.kind).toBe("transcribing");
    expect(effects).toEqual([{ type: "start-recording" }, { type: "stop-recording" }]);
  });
});

describe("combinations are not dictation", () => {
  it("another key while the trigger is held discards the recording", () => {
    const { state, effects } = run([press(0), { type: "otherKey" }]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ type: "start-recording" }, { type: "discard-recording" }]);
  });

  it("the discarded recording's late clip is ignored", () => {
    const { state, effects } = run([press(0), { type: "otherKey" }, { type: "clipReady", clip: clip(1), final: true }]);
    expect(state).toEqual(IDLE);
    expect(effects).not.toContainEqual({ type: "transcribe", clip: clip(1) });
  });

  it("a combination on the stopping tap keeps the latched session going", () => {
    const latched = run([press(0), release(10), press(500)]).state;
    const { state, effects } = run([{ type: "otherKey" }, release(600)], latched);
    expect(state).toMatchObject({ kind: "listening", press: { kind: "latched" } });
    expect(effects).toEqual([]);
  });

  it("typing while latched does not stop or cancel", () => {
    const latched = run([press(0), release(10)]).state;
    expect(run([{ type: "otherKey" }], latched)).toEqual({ state: latched, effects: [] });
  });
});

describe("clips", () => {
  it("transcribes clips one at a time, oldest first, and ends when the last is in", () => {
    const listening = run([press(0), release(10)]).state;
    const first = run([{ type: "clipReady", clip: clip(1), final: false }], listening);
    expect(first.effects).toEqual([{ type: "transcribe", clip: clip(1) }]);
    expect(first.state.kind).toBe("listening");

    const second = run([{ type: "clipReady", clip: clip(2), final: false }], first.state);
    expect(second.effects).toEqual([]);

    const firstDone = run([{ type: "clipTranscribed", clipId: 1, stranded: "" }], second.state);
    expect(firstDone.effects).toEqual([{ type: "transcribe", clip: clip(2) }]);

    const stopped = run([{ type: "toggle", at: 1, hasTarget: true }], firstDone.state);
    const last = run([{ type: "clipReady", clip: clip(3), final: true }], stopped.state);
    expect(last.effects).toEqual([]);
    expect(last.state).toMatchObject({ kind: "transcribing", session: { recording: false } });

    const done = run(
      [
        { type: "clipTranscribed", clipId: 2, stranded: "" },
        { type: "clipTranscribed", clipId: 3, stranded: "" },
      ],
      last.state,
    );
    expect(done.effects).toEqual([{ type: "transcribe", clip: clip(3) }]);
    expect(done.state).toEqual(IDLE);
  });

  it("a stop before any audio was captured ends the session with nothing to send", () => {
    const { state, effects } = run([press(0), release(400), { type: "clipReady", clip: null, final: true }]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ type: "start-recording" }, { type: "stop-recording" }]);
  });

  it("an answer for a clip that is not in flight is ignored", () => {
    const sending = run([press(0), release(400), { type: "clipReady", clip: clip(1), final: true }]).state;
    expect(run([{ type: "clipTranscribed", clipId: 9, stranded: "" }], sending)).toEqual({
      state: sending,
      effects: [],
    });
    expect(run([{ type: "clipFailed", clipId: 9, reason: "failed" }], sending)).toEqual({
      state: sending,
      effects: [],
    });
  });

  it("text whose field is gone is offered for copying at the end", () => {
    const { state } = run([
      press(0),
      release(400),
      { type: "clipReady", clip: clip(1), final: true },
      { type: "clipTranscribed", clipId: 1, stranded: "hello there" },
    ]);
    expect(state).toEqual({ kind: "idle", notice: { kind: "stranded", text: "hello there" } });
  });

  it("the microphone ending on its own settles the session", () => {
    const listening = run([press(0), release(10)]).state;
    const { state, effects } = run([{ type: "clipReady", clip: clip(1), final: true }], listening);
    expect(state.kind).toBe("transcribing");
    expect(effects).toEqual([{ type: "transcribe", clip: clip(1) }]);
  });
});

describe("failures", () => {
  const sending = run([press(0), release(400), { type: "clipReady", clip: clip(1), final: true }]).state;

  it("keeps a failed clip for retry and re-sends it", () => {
    const failed = run([{ type: "clipFailed", clipId: 1, reason: "failed" }], sending);
    expect(failed.state).toMatchObject({ kind: "error", reason: "failed", failed: clip(1) });
    const retried = run([{ type: "retry" }], failed.state);
    expect(retried.effects).toEqual([{ type: "transcribe", clip: clip(1) }]);
    expect(run([{ type: "clipTranscribed", clipId: 1, stranded: "" }], retried.state).state).toEqual(IDLE);
  });

  it("a failure while still listening stops the recorder and keeps the rest behind the failed clip", () => {
    const listening = run([press(0), release(10), { type: "clipReady", clip: clip(1), final: false }]).state;
    const failed = run([{ type: "clipFailed", clipId: 1, reason: "exhausted" }], listening);
    expect(failed.effects).toEqual([{ type: "stop-recording" }]);
    const withLast = run([{ type: "clipReady", clip: clip(2), final: true }], failed.state);
    expect(withLast.effects).toEqual([]);
    expect(withLast.state).toMatchObject({
      kind: "error",
      failed: clip(1),
      session: { queue: [clip(2)], recording: false },
    });
    const retried = run([{ type: "retry" }], withLast.state);
    expect(retried.effects).toEqual([{ type: "transcribe", clip: clip(1) }]);
    expect(run([{ type: "clipTranscribed", clipId: 1, stranded: "" }], retried.state).effects).toEqual([
      { type: "transcribe", clip: clip(2) },
    ]);
  });

  it("a permission refusal has nothing to retry", () => {
    const { state } = run([press(0), { type: "recorderFailed", reason: "permission" }]);
    expect(state).toMatchObject({ kind: "error", reason: "permission", failed: null });
    expect(run([{ type: "retry" }], state)).toEqual({ state, effects: [] });
    expect(run([{ type: "dismiss" }], state)).toEqual({ state: IDLE, effects: [] });
  });

  it("dismissing drops the kept audio and releases a still-stopping recorder", () => {
    const listening = run([press(0), release(10), { type: "clipReady", clip: clip(1), final: false }]).state;
    const failed = run([{ type: "clipFailed", clipId: 1, reason: "failed" }], listening).state;
    expect(run([{ type: "dismiss" }], failed)).toEqual({ state: IDLE, effects: [{ type: "discard-recording" }] });
  });
});

describe("cancel", () => {
  it("Escape while listening discards the recording", () => {
    expect(run([press(0), release(10), { type: "cancel" }])).toEqual({
      state: IDLE,
      effects: [{ type: "start-recording" }, { type: "discard-recording" }],
    });
  });

  it("Escape while transcribing drops the queue, so a late answer inserts nothing", () => {
    const cancelled = run([
      press(0),
      release(400),
      { type: "clipReady", clip: clip(1), final: true },
      { type: "cancel" },
    ]).state;
    expect(cancelled).toEqual(IDLE);
    expect(run([{ type: "clipTranscribed", clipId: 1, stranded: "late" }], cancelled).state).toEqual(IDLE);
  });

  it("clears a notice", () => {
    const hinted = run([{ type: "keyDown", at: 0, hasTarget: false }]).state;
    expect(run([{ type: "dismiss" }], hinted).state).toEqual(IDLE);
  });
});
