import { describe, expect, it } from "vitest";
import {
  SESSION_REPLAY_PREFIX,
  ChatAccumulator,
  decodeDiagramToolOutput,
  decodeFrame,
  encodeFrame,
  frameOf,
  splitLines,
  threadBlocks,
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
    expect(frames).toEqual([{ type: "delta", runId: RUN, blockId: "assistant:turn-1:0", text: "Hel", cursor: 3 }]);
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
      {
        type: "tool",
        runId: RUN,
        callId: "c1",
        label: "documents_search",
        status: "running",
        input: undefined,
        facts: { kind: "search", query: null, sources: [], failure: null },
        cursor: 5,
      },
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
          result: {
            callId: "c1",
            toolName: "documents_search",
            output: { results: [{ documentId: "d1", title: "t", text: "x" }] },
          },
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
          data: {
            status,
            result: {
              callId: "c1",
              toolName: "documents_search",
              output: { results: [{ documentId: "d", title: "t", text: "x" }] },
            },
          },
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
      {
        type: "action.result",
        data: { status: "completed", result: { callId: "c1", toolName: "web_search", output: { hits: [] } } },
      },
      9,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "tool", status: "ok" });
  });

  it("replays the person's message so a reload keeps the question", () => {
    const frames = frameOf(RUN, { type: "message.received", data: { message: "How much is rent?" } }, 0);
    expect(frames).toEqual([{ type: "message", runId: RUN, role: "user", text: "How much is rent?", cursor: 0 }]);
  });

  /*
   * Value: protects=transcript order after a reload (2026-11-05: the thread
   * writer's stored rows use the bare `message` type with a `content` field,
   * which frameOf did not fold — user messages vanished from the middle of the
   * reloaded transcript and only the optimistic echoes at the bottom showed
   * them, inverting question and answer); fails_when=a stored user message
   * row produces no frame; why_new=the fold now accepts both dialects of the
   * person-turn event (stream route's TURN_BOUNDARY_EVENT_TYPES names them
   * together); seam=frameOf pure fold; no_claim=the thread writer's schema.
   */
  it("folds the thread writer's stored message dialect (bare message, content field)", () => {
    const frames = frameOf(
      RUN,
      { type: "message", data: { role: "user", content: "How much is rent?", messageId: "m1" } },
      3,
    );
    expect(frames).toEqual([
      { type: "message", runId: RUN, role: "user", text: "How much is rent?", cursor: 3, blockId: "user:stored:3" },
    ]);
  });

  it("drops the stored dialect's objective echo too", () => {
    const objective = "onboarding-interview v1\nThis session is the workspace's first-run onboarding interview.";
    expect(
      frameOf(RUN, { type: "message", data: { role: "user", content: objective } }, 0, {
        suppressObjectiveText: objective,
      }),
    ).toEqual([]);
  });

  it("does not fold an assistant-authored stored message as the person's turn", () => {
    // The reply lane's message.completed rows carry role assistant; the bare
    // `message` type is the thread writer's user-turn dialect, but a row that
    // says assistant is not the person speaking.
    const frames = frameOf(RUN, { type: "message", data: { role: "assistant", content: "Here is the answer." } }, 4);
    expect(frames).toEqual([]);
  });

  it("does not render a replacement session's replayed transcript as something the person said", () => {
    const replay = `${SESSION_REPLAY_PREFIX}\n\nUser: Research Intangible\n\nNew message from the user:\n\nName three players`;
    expect(frameOf(RUN, { type: "message.received", data: { message: replay } }, 0)).toEqual([]);
  });

  it("drops an empty received message", () => {
    expect(frameOf(RUN, { type: "message.received", data: { message: "" } }, 0)).toEqual([]);
  });

  it("drops the objective echo on a machinery run, and nothing else", () => {
    const objective = "onboarding-interview v1\nThis session is the workspace's first-run onboarding interview.";
    const suppress = { suppressObjectiveText: objective };
    // The seeded objective comes back through the stream as a received
    // message; a run whose objective is machinery must not render it as chat.
    expect(frameOf(RUN, { type: "message.received", data: { message: objective } }, 0, suppress)).toEqual([]);
    // The person's own messages still come through untouched.
    expect(frameOf(RUN, { type: "message.received", data: { message: "Gmail and Linear" } }, 1, suppress)).toEqual([
      { type: "message", runId: RUN, role: "user", text: "Gmail and Linear", cursor: 1 },
    ]);
    // Without the option (every ordinary run) nothing is suppressed.
    expect(frameOf(RUN, { type: "message.received", data: { message: objective } }, 2)).toEqual([
      { type: "message", runId: RUN, role: "user", text: objective, cursor: 2 },
    ]);
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

  it("carries Eve's reason on a terminal failed end frame", () => {
    const [frame] = frameOf(
      RUN,
      {
        type: "session.failed",
        data: { code: "MODEL_CALL_FAILED", message: "Request too large for model `qwen/qwen3.8-27b`." },
      },
      9,
    );
    expect(frame).toEqual({
      type: "end",
      runId: RUN,
      state: "failed",
      cursor: 9,
      error: "Request too large for model `qwen/qwen3.8-27b`.",
    });
  });

  it("falls back to the failure code when Eve sends no message", () => {
    const [frame] = frameOf(RUN, { type: "session.failed", data: { code: "MODEL_CALL_FAILED" } }, 9);
    expect(frame).toMatchObject({ type: "end", state: "failed", error: "MODEL_CALL_FAILED" });
  });

  it("bounds a paragraph-long provider failure to one wire line", () => {
    const [frame] = frameOf(RUN, { type: "session.failed", data: { message: "x".repeat(1_000) } }, 9);
    expect(frame).toMatchObject({ type: "end", state: "failed" });
    expect(frame && "error" in frame ? frame.error : "").toHaveLength(401);
    expect(frame && "error" in frame ? frame.error?.endsWith("…") : false).toBe(true);
  });

  it("carries a persisted step failure on a failed turn after reconnect", () => {
    expect(frameOf(RUN, { type: "turn.failed", data: { error: "OpenRouter needs more credits" } }, 10)).toEqual([
      { type: "turn", runId: RUN, state: "failed", cursor: 10, error: "OpenRouter needs more credits" },
    ]);
  });

  it("turns insufficient-credit failures into a safe, actionable message", () => {
    const [frame] = frameOf(
      RUN,
      {
        type: "turn.failed",
        data: {
          error:
            "This request requires more credits than available for max_tokens; see https://provider.example/account/key/123",
        },
      },
      10,
    );
    expect(frame && "error" in frame ? frame.error : "").toContain("Reduce the reply length");
    expect(frame && "error" in frame ? frame.error : "").not.toContain("provider.example");
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

  it("keeps seeded questions single when the durable stream replays, including repeated text", () => {
    const acc = new ChatAccumulator();
    acc.apply({
      type: "snapshot",
      runId: RUN,
      cursor: 0,
      blocks: threadBlocks([
        { sequence: 1, role: "user", text: "Top 50?" },
        { sequence: 2, role: "user", text: "Top 50?" },
      ]),
    });
    for (const sequence of [1, 2]) {
      for (const frame of frameOf(RUN, { type: "message", data: { role: "user", content: "Top 50?" } }, sequence))
        acc.apply(frame);
    }
    expect(acc.list().map((block) => block.text)).toEqual(["Top 50?", "Top 50?"]);
  });

  it("does not duplicate a replayed user message", () => {
    const acc = new ChatAccumulator();
    const frame: ChatFrame = { type: "message", runId: RUN, role: "user", text: "Rent?", cursor: 4 };
    acc.apply(frame);
    acc.apply(frame);
    expect(acc.list()).toHaveLength(1);
  });

  it("keeps a paired message id when a replayed block replaces the seeded one", () => {
    // The run page pairs stored message ids onto the seeded blocks. Eve
    // replays the session from the start on every connect, and a replayed
    // `block` frame carries no message id — dropping the pair would hide the
    // comment control seconds after it rendered. The block id is the identity
    // proof: same id is the same message, so the pairing survives the replace.
    const acc = new ChatAccumulator();
    acc.apply({
      type: "snapshot",
      runId: RUN,
      cursor: 0,
      blocks: [{ id: "assistant:turn_0:0", kind: "assistant", text: "Answer.", done: true, messageId: "m1" }],
    });
    acc.apply({
      type: "block",
      runId: RUN,
      blockId: "assistant:turn_0:0",
      text: "Answer.",
      finishReason: "stop",
      cursor: 1,
    });
    expect(acc.list()[0]?.messageId).toBe("m1");
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
  it("ignores valid JSON that is not a frame object", () => {
    for (const line of ["null", "true", "42", '"hello"', "[]"]) {
      expect(decodeFrame(line)).toBeNull();
    }
  });

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
    expect(decodeFrame('{"type":"turn","runId":"r","state":"waiting","cursor":3}')).toMatchObject({
      type: "turn",
      cursor: 3,
    });
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

/*
 * A live run streams Eve, and Eve replays only the turn it is currently on. So
 * a conversation resumed after a reload rendered as "This conversation has no
 * messages yet" while its stored events sat in run_events. These protect the
 * two halves of the fix: the seed carries the stored transcript, and it uses
 * the stream's own block ids so a replay replaces rather than duplicates.
 */
describe("threadBlocks", () => {
  it("turns a stored thread into user and assistant blocks in order", () => {
    const blocks = threadBlocks([
      { sequence: 1, role: "user", text: "Help me prep", turnId: null },
      { sequence: 2, role: "assistant", text: "Here is the loop", turnId: "turn_0" },
      { sequence: 3, role: "user", text: "Go on", turnId: null },
    ]);
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["user", "Help me prep"],
      ["assistant", "Here is the loop"],
      ["user", "Go on"],
    ]);
  });

  it("ids an assistant block the way the live stream would, so a replay replaces it", () => {
    const [block] = threadBlocks([{ sequence: 7, role: "assistant", text: "Answer", turnId: "turn_0" }]);
    // Exactly blockIdFor's shape: a `block` frame for turn_0 step 0 overwrites it.
    expect(block).toMatchObject({ id: "assistant:turn_0:0", done: true });
  });

  it("never repeats a block id when one turn holds two assistant answers", () => {
    // A resumed turn answers again, and the stream id carries no step number,
    // so both messages used to become `assistant:turn_0:0`. React renders
    // duplicate keys by dropping or duplicating children - the conversation
    // silently lost a message. Only the first may claim the stream's id.
    const blocks = threadBlocks([
      { sequence: 1, role: "user", text: "Question", turnId: "turn_0" },
      { sequence: 2, role: "assistant", text: "First", turnId: "turn_0" },
      { sequence: 3, role: "assistant", text: "Second", turnId: "turn_0" },
    ]);
    const ids = blocks.map((block) => block.id);
    expect(ids).toEqual(["user:stored:1", "assistant:turn_0:0", "assistant:stored:3"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keys a message with no turnId by sequence, since no replay can collide with it", () => {
    const blocks = threadBlocks([
      { sequence: 4, role: "user", text: "Question", turnId: null },
      { sequence: 5, role: "assistant", text: "Answer", turnId: null },
    ]);
    expect(blocks.map((block) => block.id)).toEqual(["user:stored:4", "assistant:stored:5"]);
  });

  it("seeds nothing for an empty thread, so the surface keeps its empty prompt", () => {
    expect(threadBlocks([])).toEqual([]);
  });

  it("complete seeded blocks carry no feedback toolbar until the stream speaks", () => {
    // done:true is what the surface keys the toolbar off; a stored block is
    // final, which is correct — the stored feedback lives on the static branch.
    const [block] = threadBlocks([{ sequence: 1, role: "assistant", text: "x", turnId: "turn_1" }]);
    expect(block?.done).toBe(true);
  });
});

/*
 * A seeded block and Eve's replay of the same turn share one block id. If a
 * replayed delta were appended to a finished block, the answer would render
 * with its second half duplicated.
 */
describe("ChatAccumulator with a seeded transcript", () => {
  it("ignores replayed deltas for a block the seed already completed", () => {
    const acc = new ChatAccumulator();
    const seed = threadBlocks([
      { sequence: 2, role: "assistant", text: "Sierra retired its coding rounds.", turnId: "turn_0" },
    ]);
    acc.apply({ type: "snapshot", runId: RUN, blocks: seed, cursor: 0 });
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:turn_0:0", text: "Sierra retired", cursor: 1 });
    expect(acc.assistantText()).toBe("Sierra retired its coding rounds.");
  });

  it("still appends deltas to a block that is still streaming", () => {
    const acc = new ChatAccumulator();
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:turn_1:0", text: "Hel", cursor: 1 });
    acc.apply({ type: "delta", runId: RUN, blockId: "assistant:turn_1:0", text: "lo", cursor: 2 });
    expect(acc.assistantText()).toBe("Hello");
  });

  it("lets the authoritative block frame replace a seeded block", () => {
    const acc = new ChatAccumulator();
    const seed = threadBlocks([{ sequence: 2, role: "assistant", text: "Partial stored text", turnId: "turn_0" }]);
    acc.apply({ type: "snapshot", runId: RUN, blocks: seed, cursor: 0 });
    acc.apply({
      type: "block",
      runId: RUN,
      blockId: "assistant:turn_0:0",
      text: "The full answer.",
      finishReason: "stop",
      cursor: 9,
    });
    expect(acc.assistantText()).toBe("The full answer.");
  });
});

describe("decodeDiagramToolOutput", () => {
  // The diagram card renders whatever this function returns, so every
  // assertion here protects an observable card state: a valid payload decodes
  // with the source intact, and anything malformed — an error envelope, the
  // capPayload truncated marker, junk fields — returns null so the card
  // renders its honest failure state instead of a half-filled diagram.
  const CANVAS = "22222222-2222-4222-8222-222222222222";
  const ARTIFACT = "33333333-3333-4333-8333-333333333333";
  const payload = {
    ok: true,
    canvasId: CANVAS,
    artifactId: ARTIFACT,
    version: 2,
    diagramType: "flowchart",
    mermaid: "flowchart TD\n  a --> b",
  };

  it("decodes a valid success payload with the source intact", () => {
    expect(decodeDiagramToolOutput(payload)).toEqual({
      canvasId: CANVAS,
      artifactId: ARTIFACT,
      version: 2,
      diagramType: "flowchart",
      mermaid: "flowchart TD\n  a --> b",
    });
  });

  it("decodes the mermaidOmitted shape to a null source, not a failure", () => {
    // diagramToolPayload drops the source when the whole result would exceed
    // MAX_TOOL_PAYLOAD; the card must still render chrome and link the
    // artifact — it just cannot render a preview.
    const { mermaid: _source, ...lean } = payload;
    expect(decodeDiagramToolOutput({ ...lean, mermaidOmitted: true })).toEqual({
      canvasId: CANVAS,
      artifactId: ARTIFACT,
      version: 2,
      diagramType: "flowchart",
      mermaid: null,
    });
  });

  it("accepts every diagram type the tool accepts", () => {
    for (const diagramType of ["flowchart", "sequence", "class", "state", "er", "journey", "gantt", "mindmap"]) {
      expect(decodeDiagramToolOutput({ ...payload, diagramType })?.diagramType).toBe(diagramType);
    }
  });

  it("rejects the error envelope so a refused call never renders a diagram", () => {
    expect(decodeDiagramToolOutput({ ok: false, error: "the diagram has about 80 nodes; the cap is 60." })).toBeNull();
  });

  it("rejects the capPayload truncated marker", () => {
    expect(
      decodeDiagramToolOutput({
        truncated: true,
        reason: "Result over 8192 bytes; the full output stays in the run's recorded events.",
      }),
    ).toBeNull();
  });

  it("rejects null, non-objects, and arrays", () => {
    expect(decodeDiagramToolOutput(null)).toBeNull();
    expect(decodeDiagramToolOutput(undefined)).toBeNull();
    expect(decodeDiagramToolOutput("flowchart TD")).toBeNull();
    expect(decodeDiagramToolOutput([payload])).toBeNull();
  });

  it("rejects malformed ids, versions, and types", () => {
    expect(decodeDiagramToolOutput({ ...payload, canvasId: "not-a-uuid" })).toBeNull();
    expect(decodeDiagramToolOutput({ ...payload, artifactId: 42 })).toBeNull();
    expect(decodeDiagramToolOutput({ ...payload, version: 0 })).toBeNull();
    expect(decodeDiagramToolOutput({ ...payload, version: 1.5 })).toBeNull();
    expect(decodeDiagramToolOutput({ ...payload, diagramType: "org-chart" })).toBeNull();
  });

  it("rejects an empty mermaid string (absent is allowed, empty is a lie)", () => {
    expect(decodeDiagramToolOutput({ ...payload, mermaid: "" })).toBeNull();
    expect(decodeDiagramToolOutput({ ...payload, mermaid: 7 })).toBeNull();
  });

  it("is forward-compatible: unknown extra fields do not block a decode", () => {
    expect(decodeDiagramToolOutput({ ...payload, renderMode: "excalidraw", somethingNew: true })?.canvasId).toBe(
      CANVAS,
    );
  });
});
