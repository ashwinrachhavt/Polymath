// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The chat stream hook turns a `turn` frame with state "failed" into a
 * surfaced error with the composer still open: the bridge parks the run at
 * waiting_input and the session takes follow-ups (eve protocol), so the
 * conversation is not over — but the failure must not render as a normal
 * waiting state with no explanation.
 *
 * Value: protects=a failed turn surfacing an honest error while keeping the
 * follow-up path; fails_when=the hook treats turn:failed as terminal (the
 * composer closes, "This conversation has ended" shows with no error) or as
 * a silent waiting state; why_new=stream-contract.test.ts covers the frame
 * accumulator only, never the hook's state transitions; seam=fetch mocked at
 * module level (the wire format is stream-contract.test.ts's seam);
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

const USER = { id: "u1", workspaceId: "w1" };
const RUN = "6557a1d2-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useChatStream failed-turn handling", () => {
  it("surfaces a failed turn as an error but keeps the follow-up path open", async () => {
    mockStreamOnce([
      { type: "message", runId: RUN, role: "user", text: "Are you connected to Notion?", cursor: 2 },
      { type: "turn", runId: RUN, state: "failed", cursor: 4 },
      { type: "end", runId: RUN, state: "failed", cursor: 5 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.connection).toBe("waiting"));
    await waitFor(() => expect(result.current.error).toContain("failed"));
    // The conversation is NOT over: connection is waiting, not done.
    expect(result.current.connection).toBe("waiting");
    expect(result.current.error).toBe("The last reply failed. You can send another message.");
  });

  it("does not mark the stream done on a failed turn", async () => {
    mockStreamOnce([
      { type: "turn", runId: RUN, state: "failed", cursor: 3 },
    ]);
    const { result } = renderHook(() => useChatStream(RUN, { enabled: true }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.connection).not.toBe("done");
  });
});
