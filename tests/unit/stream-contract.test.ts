import { describe, expect, it } from "vitest";
import {
  ChatAccumulator,
  decodeFrame,
  encodeFrame,
  frameOf,
  splitLines,
  type ChatFrame,
} from "@/domains/agents/stream-contract";

/*
 * The chat stream contract. These are the frames the proxy writes and the
 * surface renders, so every assertion here protects observable chat behavior:
 * text arriving incrementally, a finished block replacing its deltas, and a
 * replayed delta not doubling the reply.
 */

const RUN = "11111111-1111-4111-8111-111111111111";

describe("frameOf", () => {
  it("turns an assistant delta into a delta frame keyed by turn and step", () => {
    const frames = frameOf(
      RUN,
      { type: "message.appended", data: { messageDelta: "Hel", turnId: "turn-1", stepIndex: 0 } },
      3,
    );
    expect(frames).toEqual([
      { type: "delta", runId: RUN, blockId: "assistant:turn-1:0", text: "Hel", cursor: 3 },
    ]);
  });

  it("keeps two assistant messages in one turn in separate blocks", () => {
    // Eve emits an interim reply before a tool call and a final reply after it.
    // Merging them would splice narration into the answer.
    const first = frameOf(
      RUN,
      { type: "message.appended", data: { messageDelta: "Let me look.", turnId: "t", stepIndex: 0 } },
      1,
    );
    const second = frameOf(
      RUN,
      { type: "message.appended", data: { messageDelta: "Found it.", turnId: "t", stepIndex: 2 } },
      2,
    );
    expect(first[0]).toMatchObject({ blockId: "assistant:t:0" });
    expect(second[0]).toMatchObject({ blockId: "assistant:t:2" });
  });

  it("separates reasoning from assistant text", () => {
    const [frame] = frameOf(
      RUN,
      { type: "reasoning.appended", data: { reasoningDelta: "hmm", turnId: "t", stepIndex: 0 } },
      1,
    );
    expect(frame).toMatchObject({ type: "delta", blockId: "reasoning:t:0" });
  });

  it("ignores an empty delta rather than emitting a no-op frame", () => {
    expect(frameOf(RUN, { type: "message.appended", data: { messageDelta: "" } }, 1)).toEqual([]);
    expect(frameOf(RUN, { type: "message.appended", data: {} }, 1)).toEqual([]);
  });

  it("carries the finish reason on a completed block", () => {
    const [frame] = frameOf(
      RUN,
      { type: "message.completed", data: { message: "Done.", turnId: "t", stepIndex: 1, finishReason: "stop" } },
      4,
    );
    expect(frame).toEqual({
      type: "block",
      runId: RUN,
      blockId: "assistant:t:1",
      text: "Done.",
      finishReason: "stop",
      cursor: 4,
    });
  });

  it("frames a requested tool call as running", () => {
    const frames = frameOf(
      RUN,
      {
        type: "actions.requested",
        data: { actions: [{ kind: "tool-call", callId: "c1", toolName: "documents_search" }, { kind: "other" }] },
      },
      5,
    );
    expect(frames).toEqual([
      { type: "tool", runId: RUN, callId: "c1", label: "documents_search", status: "running", cursor: 5 },
    ]);
  });

  it("frames a rejected tool call as an error, not a success", () => {
    // A HITL rejection means the tool never ran; showing it as ok would claim
    // an external effect that did not happen.
    const [frame] = frameOf(
      RUN,
      { type: "action.result", data: { status: "rejected", result: { callId: "c1", toolName: "gmail_send" } } },
      6,
    );
    expect(frame).toMatchObject({ type: "tool", callId: "c1", status: "error" });
  });

  it("emits citations from a successful search result", () => {
    const frames = frameOf(
      RUN,
      {
        type: "action.result",
        data: {
          status: "completed",
          result: {
            callId: "c1",
            toolName: "documents_search",
            output: {
              results: [
                { documentId: "d1", title: "Lease", text: "Rent is due.", span: { start: 10, end: 22, page: 3 } },
                { documentId: "d1", title: "Lease", text: "Rent is due.", span: { start: 10, end: 22, page: 3 } },
              ],
            },
          },
        },
      },
      7,
    );
    const citations = frames.find((frame) => frame.type === "citations");
    expect(citations).toBeDefined();
    if (citations?.type !== "citations") throw new Error("no citations frame");
    // The duplicate span collapses; the surface must not show the same passage twice.
    expect(citations.citations).toEqual([
      { documentId: "d1", title: "Lease", text: "Rent is due.", span: { start: 10, end: 22, page: 3 } },
    ]);
  });

  it("does not claim citations for a tool that failed", () => {
    const frames = frameOf(
      RUN,
      {
        type: "action.result",
        data: {
          status: "failed",
          result: { callId: "c1", toolName: "documents_search", output: { results: [{ documentId: "d1", title: "t", text: "x" }] } },
        },
      },
      8,
    );
    expect(frames.some((frame) => frame.type === "citations")).toBe(false);
  });

  it("does not treat an unknown or cancelled tool status as success", () => {
    // Only an explicit success may render as ok or produce citations. An
    // unknown outcome is missing evidence, not a completed effect.
    for (const status of ["cancelled", "timeout", "denied", undefined]) {
      const frames = frameOf(
        RUN,
        {
          type: "action.result",
          data: { status, result: { callId: "c1", toolName: "documents_search", output: { results: [{ documentId: "d", title: "t", text: "x" }] } } },
        },
        1,
      );
      expect(frames[0]).toMatchObject({ type: "tool", status: "error" });
      expect(frames.some((frame) => frame.type === "citations")).toBe(false);
    }
  });

  it("ignores a tool output with no citable results", () => {
    const frames = frameOf(
      RUN,
      { type: "action.result", data: { status: "completed", result: { callId: "c1", toolName: "web_search", output: { hits: [] } } } },
      9,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "tool", status: "ok" });
  });

  it("replays the person's message so a reload keeps the question", () => {
    const frames = frameOf(RUN, { type: "message.received", data: { message: "How much is rent?" } }, 0);
    expect(frames).toEqual([{ type: "message", runId: RUN, role: "user", text: "How much is rent?", cursor: 0 }]);
  });

  it("drops an empty received message", () => {
    expect(frameOf(RUN, { type: "message.received", data: { message: "" } }, 0)).toEqual([]);
  });

  it("maps a cancelled turn to a turn frame, not an end frame", () => {
    // The session survives a cancelled turn and accepts the next message, so
    // the surface must keep the composer open.
    expect(frameOf(RUN, { type: "turn.cancelled" }, 7)).toEqual([
      { type: "turn", runId: RUN, state: "cancelled", cursor: 7 },
    ]);
  });

  it("maps session completion to a terminal end frame", () => {
    expect(frameOf(RUN, { type: "session.completed" }, 8)).toEqual([
      { type: "end", runId: RUN, state: "succeeded", cursor: 8 },
    ]);
  });

  it("drops lifecycle events the surface does not render", () => {
    for (const type of ["session.started", "step.started", "step.completed", "usage", "compaction.completed"]) {
      expect(frameOf(RUN, { type }, 1)).toEqual([]);
    }
  });
});

describe("ChatAccumulator", () => {
  it("accumulates deltas into one reply", () => {
    const acc = new ChatAccumulator();
    for (const [i, text] of ["Hello", ", ", "world"].entries()) {
      acc.apply({ type: "delta", runId: RUN, blockId: "assistant:t:0", text, cursor: i });
    }
    expect(acc.assistantText()).toBe("Hello, world");
  });

  it("does not duplicate a replayed delta", () => {
    // Eve may replay a coalesced delta after a reconnect. The cursor is the
    // idempotency key, so this must be a no-op rather than "HelloHello".
    const acc = new ChatAccumulator();
    const frame: ChatFrame = { type: "delta", runId: RUN, blockId: "assistant:t:0", text: "Hello", cursor: 3 };
    acc.apply(frame);
    acc.apply(frame);
    expect(acc.assistantText()).toBe("Hello");
  });

  it("lets a completed block replace accumulated deltas", () => {
    const acc = new ChatAccumulator();
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:t:0", text: "Hel", cursor: 0 });
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:t:0", text: "lo", cursor: 1 });
    acc.apply({
      type: "block",
      runId: RUN,
      blockId: "assistant:t:0",
      text: "Hello.",
      finishReason: "stop",
      cursor: 2,
    });
    expect(acc.assistantText()).toBe("Hello.");
    expect(acc.list()[0]?.done).toBe(true);
  });

  it("keeps the person's message and the assistant reply in order", () => {
    const acc = new ChatAccumulator();
    acc.apply({ type: "message", runId: RUN, role: "user", text: "Rent?", cursor: 0 });
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:t:0", text: "2,400", cursor: 1 });
    expect(acc.list().map((b) => `${b.kind}:${b.text}`)).toEqual(["user:Rent?", "assistant:2,400"]);
  });

  it("does not duplicate a replayed user message", () => {
    const acc = new ChatAccumulator();
    const frame: ChatFrame = { type: "message", runId: RUN, role: "user", text: "Rent?", cursor: 4 };
    acc.apply(frame);
    acc.apply(frame);
    expect(acc.list()).toHaveLength(1);
  });

  it("keeps reasoning out of the visible reply", () => {
    const acc = new ChatAccumulator();
    acc.apply({ type: "delta", runId: RUN, blockId: "reasoning:t:0", text: "thinking", cursor: 0 });
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:t:0", text: "answer", cursor: 1 });
    expect(acc.assistantText()).toBe("answer");
    expect(acc.list().map((b) => b.kind)).toEqual(["reasoning", "assistant"]);
  });

  it("replaces state on a snapshot", () => {
    const acc = new ChatAccumulator();
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:t:0", text: "stale", cursor: 0 });
    acc.apply({
      type: "snapshot",
      runId: RUN,
      blocks: [{ id: "assistant:t:0", kind: "assistant", text: "fresh", done: true }],
      cursor: 9,
    });
    expect(acc.assistantText()).toBe("fresh");
  });

  it("ignores frames that carry no text", () => {
    const acc = new ChatAccumulator();
    acc.apply({ type: "tool", runId: RUN, callId: "c1", label: "documents_search", status: "ok", cursor: 1 });
    acc.apply({ type: "turn", runId: RUN, state: "waiting", cursor: 2 });
    expect(acc.list()).toEqual([]);
  });
});

describe("wire framing", () => {
  it("round-trips a frame through one NDJSON line", () => {
    const frame: ChatFrame = { type: "delta", runId: RUN, blockId: "assistant:t:0", text: "a\nb", cursor: 1 };
    const encoded = encodeFrame(frame);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n")).toHaveLength(2);
    expect(decodeFrame(encoded.trim())).toEqual(frame);
  });

  it("refuses a line that is not a frame", () => {
    expect(decodeFrame("")).toBeNull();
    expect(decodeFrame("not json")).toBeNull();
    expect(decodeFrame('{"type":"delta"}')).toBeNull();
    expect(decodeFrame('{"runId":"x"}')).toBeNull();
  });

  it("refuses a frame missing the fields its consumer reads", () => {
    // A delta without a cursor made Math.max(cursor, undefined) NaN, which the
    // client then sent back as x-chat-cursor: NaN and the route read as 0,
    // forcing a full replay on every reconnect.
    expect(decodeFrame('{"type":"delta","runId":"r","text":"x","cursor":1}')).toBeNull();
    expect(decodeFrame('{"type":"delta","runId":"r","blockId":"b","cursor":1}')).toBeNull();
    expect(decodeFrame('{"type":"delta","runId":"r","blockId":"b","text":"x"}')).toBeNull();
    expect(decodeFrame('{"type":"delta","runId":"r","blockId":"b","text":"x","cursor":null}')).toBeNull();
  });

  it("accepts a stateless frame that carries only a cursor", () => {
    expect(decodeFrame('{"type":"turn","runId":"r","state":"waiting","cursor":3}')).toMatchObject({ type: "turn", cursor: 3 });
    expect(decodeFrame('{"type":"end","runId":"r","state":"succeeded","cursor":4}')).toMatchObject({ type: "end" });
  });

  it("drops an unknown frame type rather than passing it through", () => {
    expect(decodeFrame('{"type":"deltaa","runId":"r","blockId":"b","text":"x","cursor":1}')).toBeNull();
  });

  it("keeps an unterminated trailing line out of the parsed set", () => {
    // A chunk boundary can split a frame in half; the remainder must wait.
    const { lines, rest } = splitLines('{"a":1}\n{"b":2');
    expect(lines).toEqual(['{"a":1}']);
    expect(rest).toBe('{"b":2');
  });
});
