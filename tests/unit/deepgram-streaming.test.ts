// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deepgramStreamingTranscriptionProvider,
  type DeepgramSocket,
} from "@/integrations/transcription/deepgram";
import { streamingTranscriptionProvider } from "@/integrations/transcription/streaming";

/* A faithful mock of the Deepgram listen socket: records every sent frame,
 * lets the test drive open/message/close exactly as the server would. */
function fakeSocket() {
  const sent: (string | Uint8Array)[] = [];
  const socket: DeepgramSocket & {
    open(): void;
    message(frame: unknown): void;
    closeFromServer(event?: { code?: number; wasClean?: boolean }): void;
    closed: boolean;
  } = {
    readyState: 0,
    closed: false,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      sent.push(data);
    },
    close() {
      this.closed = true;
      this.onclose?.({ code: 1000, wasClean: true });
    },
    open() {
      this.onopen?.();
    },
    message(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    },
    closeFromServer(event = { code: 1006, wasClean: false }) {
      this.closed = true;
      this.onclose?.(event);
    },
  };
  const jsonFrames = () =>
    sent.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f) as { type: string });
  return { socket, sent, jsonFrames };
}

function resultsFrame(transcript: string, isFinal: boolean, extra: Record<string, unknown> = {}) {
  return {
    type: "Results",
    channel: { alternatives: [{ transcript }] },
    is_final: isFinal,
    speech_final: isFinal,
    ...extra,
  };
}

function makeProvider(socket: ReturnType<typeof fakeSocket>["socket"], extra: Record<string, unknown> = {}) {
  let seenUrl = "";
  let seenProtocols: string[] = [];
  const provider = deepgramStreamingTranscriptionProvider({
    apiKey: "dg-test-key",
    socketFactory: (url, protocols) => {
      seenUrl = url;
      seenProtocols = protocols;
      return socket;
    },
    ...extra,
  });
  return { provider, seen: () => ({ url: seenUrl, protocols: seenProtocols }) };
}

describe("deepgram streaming adapter (protocol, mocked transport)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("requires DEEPGRAM_API_KEY and fails loudly without it", () => {
    expect(() => deepgramStreamingTranscriptionProvider()).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("is selectable through the explicit seam only when the key is present", () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "deepgram");
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test-key");
    expect(streamingTranscriptionProvider().registryId).toBe("deepgram");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(() => streamingTranscriptionProvider()).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("opens the listen URL with nova-3 + interim results and the token subprotocol", async () => {
    const mock = fakeSocket();
    const { provider, seen } = makeProvider(mock.socket);
    const pending = provider.startSession({});
    mock.socket.open();
    await pending;
    const url = new URL(seen().url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(seen().protocols).toEqual(["token", "dg-test-key"]);
  });

  it("buffers audio until the socket opens, then flushes in order", async () => {
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    // The session resolves before the socket opens; audio buffers until then.
    const session = await provider.startSession({});
    session.sendAudio(new Uint8Array([1]));
    session.sendAudio(new Uint8Array([2]));
    expect(mock.sent.filter((f) => f instanceof Uint8Array)).toEqual([]);
    mock.socket.open();
    session.sendAudio(new Uint8Array([3]));
    const binary = mock.sent.filter((f) => f instanceof Uint8Array);
    expect(binary).toEqual([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    session.cancel();
  });

  it("maps interim frames to onInterim and is_final frames to onFinal", async () => {
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const interims: string[] = [];
    const finals: string[] = [];
    const pending = provider.startSession({
      onInterim: (t) => interims.push(t),
      onFinal: (s) => finals.push(s.text),
    });
    mock.socket.open();
    const session = await pending;
    mock.socket.message(resultsFrame("send the", false));
    mock.socket.message(resultsFrame("send the roadmap", false));
    mock.socket.message(resultsFrame("Send the roadmap.", true));
    mock.socket.message({ type: "Metadata", transaction_key: "x" });
    expect(interims).toEqual(["send the", "send the roadmap"]);
    expect(finals).toEqual(["Send the roadmap."]);
    session.cancel();
  });

  it("stop() Finalizes, waits for the from_finalize flush, then CloseStreams - trailing words preserved", async () => {
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const finals: { text: string }[] = [];
    const pending = provider.startSession({ onFinal: (s) => finals.push(s) });
    mock.socket.open();
    const session = await pending;
    const stopping = session.stop();
    expect(mock.jsonFrames()).toEqual([{ type: "Finalize" }]);
    // The server answers Finalize with the buffered words, marked from_finalize.
    mock.socket.message(resultsFrame("trailing words", true, { from_finalize: true }));
    await stopping;
    expect(finals.map((f) => f.text)).toEqual(["trailing words"]);
    expect(mock.jsonFrames().map((f) => f.type)).toEqual(["Finalize", "CloseStream"]);
    expect(mock.socket.closed).toBe(true);
  });

  it("stop() still closes cleanly if the flush never arrives", async () => {
    vi.useFakeTimers();
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const pending = provider.startSession({});
    mock.socket.open();
    const session = await pending;
    const stopping = session.stop();
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    expect(mock.jsonFrames().map((f) => f.type)).toEqual(["Finalize", "CloseStream"]);
    expect(mock.socket.closed).toBe(true);
  });

  it("cancel() CloseStreams immediately without Finalize", async () => {
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const pending = provider.startSession({});
    mock.socket.open();
    const session = await pending;
    session.cancel();
    expect(mock.jsonFrames()).toEqual([{ type: "CloseStream" }]);
    expect(mock.socket.closed).toBe(true);
  });

  it("surfaces an unexpected server close as onError", async () => {
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const errors: Error[] = [];
    const pending = provider.startSession({ onError: (e) => errors.push(e) });
    mock.socket.open();
    const session = await pending;
    mock.socket.closeFromServer({ code: 1006, wasClean: false });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/closed unexpectedly/);
    session.cancel();
  });

  it("surfaces a Deepgram Error frame as onError", async () => {
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const errors: Error[] = [];
    const pending = provider.startSession({ onError: (e) => errors.push(e) });
    mock.socket.open();
    await pending;
    mock.socket.message({ type: "Error", description: "Insufficient funds" });
    expect(errors[0]?.message).toBe("Insufficient funds");
  });

  it("sends KeepAlive while the socket is open", async () => {
    vi.useFakeTimers();
    const mock = fakeSocket();
    const { provider } = makeProvider(mock.socket);
    const pending = provider.startSession({});
    mock.socket.open();
    const session = await pending;
    await vi.advanceTimersByTimeAsync(8_100);
    expect(mock.jsonFrames()).toContainEqual({ type: "KeepAlive" });
    session.cancel();
  });
});
