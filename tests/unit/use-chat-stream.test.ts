// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response(ndjson(frames), { status: 200 })));
}

import { useChatStream } from "@/components/chat/use-chat-stream";

const RUN = "6557a1d2-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useChatStream terminal run failure (end frame state \"failed\")", () => {
  it("surfaces the terminal truth with runFailed and no stream retry", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "user", text: "Are you connected to Notion?", cursor: 2 },
      { type: "turn", runId: RUN, state: "failed", cursor: 4 },
      { type: "end", runId: RUN, state: "failed", cursor: 5 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.runFailed).toBe(true));
    expect(result.current.connection).toBe("done");
    expect(result.current.error).toBe("This run failed. Retry it to start a new run.");
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
    expect(result.current.error).toBe("This run failed. Retry it to start a new run.");
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
});
