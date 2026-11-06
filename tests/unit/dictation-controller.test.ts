// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamingTranscriptionProvider,
  StreamingTranscriptionUnconfiguredError,
} from "@/integrations/transcription/streaming";
import type {
  ClientDictationEvents,
  ClientDictationProvider,
} from "@/lib/speech/client-dictation";
import {
  FIXTURE_STREAMING_SEGMENTS,
  fixtureStreamingTranscriptionProvider,
} from "@/integrations/transcription/streaming-fixture";
import { createDictationController, type FieldAdapter } from "@/lib/speech/dictation-controller";

/* A string-buffer field: the minimal honest fake of a textarea. */
function fakeField(initial = "", caret?: number) {
  let value = initial;
  let caretOffset = caret ?? initial.length;
  const adapter: FieldAdapter = {
    replaceRange(start, end, text) {
      value = value.slice(0, start) + text + value.slice(end);
      caretOffset = start + text.length;
    },
    caretOffset: () => caretOffset,
  };
  return { adapter, value: () => value, setCaret: (n: number) => (caretOffset = n) };
}

function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function fakeMedia(stream: MediaStream) {
  return vi.fn(async () => stream);
}

/* A scripted session: emits steps on demand so tests drive the sequence deterministically. */
function scriptedProvider(script: Array<() => void>) {
  let events: ClientDictationEvents | null = null;
  const provider: ClientDictationProvider = {
    name: "test:scripted",
    async startSession(e) {
      events = e;
      return {
        async stop() {
          events?.onFinal?.({ text: "trailing words", trailing: true });
        },
        cancel() {},
      };
    },
  };
  const emit = {
    interim: (t: string) => events?.onInterim?.(t),
    final: (t: string) => events?.onFinal?.({ text: t, trailing: false }),
    error: (err: Error) => events?.onError?.(err),
  };
  void script;
  return { provider, emit };
}

describe("streaming provider selection (issue #532)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is unconfigured without an explicit choice - dictation never activates itself", () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "");
    expect(() => streamingTranscriptionProvider()).toThrow(StreamingTranscriptionUnconfiguredError);
  });

  it("selects the fixture only by the explicit choice", () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "fixture");
    expect(streamingTranscriptionProvider().registryId).toBe("fixture");
  });

  it("requires DEEPGRAM_API_KEY before the deepgram adapter can be selected", () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "deepgram");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(() => streamingTranscriptionProvider()).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("rejects unknown selectors", () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "assemblyai");
    expect(() => streamingTranscriptionProvider()).toThrow(/must be fixture or deepgram/);
  });

  it("the fixture delivers its scripted interim -> final sequence and stop preserves a trailing flush", async () => {
    vi.useFakeTimers();
    const interims: string[] = [];
    const finals: string[] = [];
    const session = await fixtureStreamingTranscriptionProvider().startSession({
      onInterim: (t) => interims.push(t),
      onFinal: (s) => finals.push(s.text),
    });
    await vi.runAllTimersAsync();
    expect(interims).toEqual(FIXTURE_STREAMING_SEGMENTS.map((s) => s.interim));
    expect(finals.slice(0, 2)).toEqual(FIXTURE_STREAMING_SEGMENTS.map((s) => s.final));
    await session.stop();
    expect(finals[finals.length - 1]).toBe("");
    vi.useRealTimers();
  });
});

describe("dictation controller", () => {
  it("commits interim hypotheses exactly once when the final lands", async () => {
    const field = fakeField();
    const media = fakeStream();
    const { provider, emit } = scriptedProvider([]);
    const controller = createDictationController({
      provider,
      field: field.adapter,
      getUserMedia: fakeMedia(media.stream),
    });
    await controller.start();
    expect(controller.state()).toBe("listening");
    emit.interim("send the");
    emit.interim("send the roadmap");
    emit.final("Send the roadmap.");
    expect(field.value()).toBe("Send the roadmap.");
    await controller.stop();
    expect(field.value()).toBe("Send the roadmap.trailing words");
  });

  it("never overwrites text typed elsewhere while recognition runs", async () => {
    const field = fakeField();
    const media = fakeStream();
    const { provider, emit } = scriptedProvider([]);
    const controller = createDictationController({
      provider,
      field: field.adapter,
      getUserMedia: fakeMedia(media.stream),
    });
    await controller.start();
    emit.interim("draft a note");
    // The user types their own words at the caret, after the interim span.
    field.adapter.replaceRange(field.adapter.caretOffset(), field.adapter.caretOffset(), "MY TYPED TEXT");
    // Recognition keeps streaming; only the owned interim span is replaced.
    emit.interim("draft a note to Priya");
    emit.final("Draft a note to Priya.");
    expect(field.value()).toBe("Draft a note to Priya.MY TYPED TEXT");
    await controller.cancel();
  });

  it("inserts at the caret, not over the existing text", async () => {
    const field = fakeField("existing prompt", 9);
    const media = fakeStream();
    const { provider, emit } = scriptedProvider([]);
    const controller = createDictationController({
      provider,
      field: field.adapter,
      getUserMedia: fakeMedia(media.stream),
    });
    await controller.start();
    emit.final("ADDED");
    expect(field.value()).toBe("existing ADDEDprompt");
    await controller.cancel();
  });

  it("cancel discards the uncommitted interim but keeps committed finals", async () => {
    const field = fakeField();
    const media = fakeStream();
    const { provider, emit } = scriptedProvider([]);
    const controller = createDictationController({
      provider,
      field: field.adapter,
      getUserMedia: fakeMedia(media.stream),
    });
    await controller.start();
    emit.final("Keep this.");
    emit.interim("uncommitted guess");
    await controller.cancel();
    expect(field.value()).toBe("Keep this.");
    expect(controller.state()).toBe("idle");
  });

  it("stops every mic track on stop, cancel and provider error", async () => {
    for (const scenario of ["stop", "cancel", "error"] as const) {
      const field = fakeField();
      const media = fakeStream();
      const { provider, emit } = scriptedProvider([]);
      const controller = createDictationController({
        provider,
        field: field.adapter,
        getUserMedia: fakeMedia(media.stream),
      });
      await controller.start();
      if (scenario === "stop") await controller.stop();
      else if (scenario === "cancel") await controller.cancel();
      else emit.error(new Error("socket closed"));
      for (const track of media.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("surfaces mic permission denial as an error state, never stuck listening", async () => {
    const field = fakeField();
    const denied = new DOMException("Permission denied", "NotAllowedError");
    const noopClientProvider: ClientDictationProvider = {
      name: "test:noop",
      startSession: async () => ({ async stop() {}, cancel() {} }),
    };
    const controller = createDictationController({
      provider: noopClientProvider,
      field: field.adapter,
      getUserMedia: async () => {
        throw denied;
      },
    });
    await controller.start();
    expect(controller.state()).toBe("error");
    expect(field.value()).toBe("");
  });

  it("undo removes the last committed span and nothing else", async () => {
    const field = fakeField();
    const media = fakeStream();
    const { provider, emit } = scriptedProvider([]);
    const controller = createDictationController({
      provider,
      field: field.adapter,
      getUserMedia: fakeMedia(media.stream),
    });
    await controller.start();
    emit.final("First. ");
    emit.final("Second.");
    expect(field.value()).toBe("First. Second.");
    expect(controller.undoInsertion()).toBe(true);
    expect(field.value()).toBe("First. ");
    expect(controller.undoInsertion()).toBe(true);
    expect(field.value()).toBe("");
    expect(controller.undoInsertion()).toBe(false);
    await controller.cancel();
  });
});
