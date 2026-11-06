// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The chat stream hook distinguishes a failed TURN from a failed RUN.
 *
 * A turn failure alone (the stream closes or the lease ends with no end
 * frame) is recoverable: the bridge parks the run at waiting_input and the
 * session takes follow-ups (eve protocol), so the error must surface while
 * the follow-up path stays open.
 *
 * An `end` frame whose state is "failed" is different in kind: only a
 * run.failed event produces it, so the run row is terminal and its session
 * closed — a follow-up send 409s (run_finished). The hook must replace the
 * turn-failure line ("You can send another message") with the terminal
 * truth, expose runFailed for the surface's fresh-start affordance, and drop
 * retryable (the stream-side retry could only replay a closed session).
 *
 * Value: protects=the F6 reconciliation (no guidance promising a send the
 * run cannot take) and the surface's ability to tell the two failures apart;
 * fails_when=the hook treats an end:failed frame as a mere lease end (the
 * turn-failure lie survives on a terminal run) or as a silent done state;
 * why_new=stream-contract.test.ts covers the frame accumulator only, never
 * the hook's state transitions; seam=fetch mocked at module level (the wire
 * format is stream-contract.test.ts's seam);
 * no_claim=the SSE transport, reconnect/backoff timing, and the surface's
 * rendering of the error.
 */

const ndjson = (frames: object[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(JSON.stringify(f) + "\n"));
      c.close();
    },
  });

function mockStreamOnce(frames: object[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(ndjson(frames), { status: 200 })),
  );
}

import { useChatStream } from "@/components/chat/use-chat-stream";

const RUN = "6557a1d2-0000-4000-8000-000000000001";

afterEach(async () => {
  // Cleanup matters here even though every assertion passes: a rendered
  // hook's pending react-dom scheduler task can fire after this file's
  // jsdom teardown and throw "window is not defined" as an uncaught
  // exception, failing the whole vitest run. setup.ui.ts registers
  // afterEach(cleanup) for the ui project, but this is a .ts file, so it
  // runs in the unit project and must arrange its own cleanup. Unmount,
  // then let any scheduled work run while the environment is still alive.
  cleanup();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useChatStream terminal run failure (end frame state "failed")', () => {
  it("surfaces the terminal truth with runFailed and no stream retry", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "user", text: "Are you connected to Notion?", cursor: 2 },
      { type: "turn", runId: RUN, state: "failed", cursor: 4 },
      { type: "end", runId: RUN, state: "failed", cursor: 5 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.runFailed).toBe(true));
    expect(result.current.connection).toBe("done");
    expect(result.current.error).toBe("This run failed.");
    expect(result.current.retryable).toBe(false);
  });

  it("replaces the turn-failure line that promises a send the closed session cannot take", async () => {
    mockStreamOnce([
      { type: "turn", runId: RUN, state: "failed", cursor: 3 },
      { type: "end", runId: RUN, state: "failed", cursor: 4 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.connection).toBe("done"));
    expect(result.current.error).not.toBe("The last reply failed. You can send another message.");
    expect(result.current.error).toBe("This run failed.");
  });

  it("shows Eve's reason instead of the generic terminal line", async () => {
    mockStreamOnce([
      { type: "turn", runId: RUN, state: "failed", cursor: 3 },
      { type: "end", runId: RUN, state: "failed", cursor: 4, error: "The provider rejected the request as too large." },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.runFailed).toBe(true));
    expect(result.current.error).toBe("This run failed: The provider rejected the request as too large.");
    expect(result.current.retryable).toBe(false);
  });

  it("leaves no failure state behind when the run ended successfully", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "assistant", text: "All set.", cursor: 2 },
      { type: "end", runId: RUN, state: "succeeded", cursor: 3 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.connection).toBe("done"));
    expect(result.current.runFailed).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("useChatStream recoverable turn failure (no terminal end frame)", () => {
  it("surfaces a failed turn as an error but keeps the follow-up path open", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "user", text: "Are you connected to Notion?", cursor: 2 },
      { type: "turn", runId: RUN, state: "failed", cursor: 4 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.error).toContain("failed"));
    // The conversation is NOT over: connection is waiting, not done — and
    // runFailed stays false, so no terminal affordance replaces the composer.
    expect(result.current.connection).not.toBe("done");
    expect(result.current.error).toBe("The last reply failed. You can send another message.");
    expect(result.current.runFailed).toBe(false);
  });

  it("names the turn's failure reason but still allows a follow-up", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "user", text: "Summarize this video.", cursor: 2 },
      { type: "turn", runId: RUN, state: "failed", cursor: 4, error: "The tool timed out." },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.error).toContain("timed out"));
    expect(result.current.connection).not.toBe("done");
    expect(result.current.error).toBe("The last reply failed: The tool timed out.");
    expect(result.current.runFailed).toBe(false);
  });
});

describe("useChatStream parked session", () => {
  it("stays waiting after a completed turn closes its stream", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "assistant", text: "Here is the answer.", cursor: 2 },
      { type: "turn", runId: RUN, state: "waiting", cursor: 3 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.blocks.some((block) => block.text === "Here is the answer.")).toBe(true));
    await waitFor(() => expect(result.current.connection).toBe("waiting"));
    expect(result.current.error).toBeNull();
  });

  it("reopens after a new message asks for another turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(ndjson([{ type: "turn", runId: RUN, state: "waiting", cursor: 2 }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          ndjson([{ type: "message", runId: RUN, role: "assistant", text: "A second answer.", cursor: 4 }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.connection).toBe("waiting"));
    result.current.retry();
    await waitFor(() => expect(result.current.blocks.some((block) => block.text === "A second answer.")).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("useChatStream run facts and the reconnect pause", () => {
  it("pins runFailed from the run frame's terminal row state", async () => {
    // The run frame is every connection's head: the durable facts arrive even
    // when the transport never replays an end frame. A failed row is terminal
    // truth — the chip renders Failed from the fact alone.
    mockStreamOnce([
      { type: "run", runId: RUN, state: "failed", lastTurnFailed: false, cursor: 1 },
      { type: "turn", runId: RUN, state: "waiting", cursor: 2 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.runFailed).toBe(true));
    expect(result.current.lastFailedTurn).toBe(false);
  });

  it("carries lastTurnFailed from the run frame and lets the person's next message supersede it", async () => {
    // Connection one opens on a run whose latest turn failed; after the pause,
    // the reconnect replays the person's follow-up — the one live fact that
    // supersedes the failure (the panel's rule). Each fetch builds a fresh
    // Response: a body reads once, so a shared instance would strand the
    // reconnect on an already-consumed stream.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(ndjson([{ type: "run", runId: RUN, state: "waiting_input", lastTurnFailed: true, cursor: 1 }]), {
          status: 200,
        }),
      )
      .mockImplementation(
        async () =>
          new Response(ndjson([{ type: "message", runId: RUN, role: "user", text: "One more try.", cursor: 3 }]), {
            status: 200,
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.lastFailedTurn).toBe(true));
    await waitFor(() => expect(result.current.lastFailedTurn).toBe(false));
  });

  it("reads a transient drop as the reconnect pause, never a failure", async () => {
    // Connection one delivers an event and dies; the hook pauses and
    // reconnects from the cursor. runFailed stays false — a drop is a pause,
    // not a run failure — and the reconnect finishes the run.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          ndjson([{ type: "message", runId: RUN, role: "user", text: "Are you connected to Notion?", cursor: 2 }]),
          {
            status: 200,
          },
        ),
      )
      .mockImplementation(
        async () =>
          new Response(
            ndjson([
              { type: "run", runId: RUN, state: "running", lastTurnFailed: false, cursor: 0 },
              { type: "message", runId: RUN, role: "assistant", text: "Yes.", cursor: 9 },
              { type: "end", runId: RUN, state: "succeeded", cursor: 10 },
            ]),
            { status: 200 },
          ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.connection).toBe("reconnecting"));
    expect(result.current.runFailed).toBe(false);
    expect(result.current.lastFailedTurn).toBe(false);
    await waitFor(() => expect(result.current.connection).toBe("done"));
    expect(result.current.runFailed).toBe(false);
  });
});
