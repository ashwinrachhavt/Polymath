/*
 * The browser-facing chat stream, as a contract rather than a transport.
 *
 * Eve's own stream is NDJSON of protocol events, and it is the authority. But
 * the browser cannot speak it directly: every Eve call needs a 60-second bridge
 * token minted server-side (bridge-token.ts), and the run/session pairing lives
 * in `agent_runs.session_ref`. So the app proxies the stream through
 * /api/v1/runs/:runId/stream and re-frames it into a small, stable vocabulary
 * that a chat surface can render without knowing Eve's protocol.
 *
 * This module is the whole contract: the frame union, the fold that turns Eve
 * events into frames, and the accumulator that rebuilds a reply from deltas.
 * It is pure — no database, no network, no Next.js — so it is unit-testable and
 * shared by the route, the client store, and the evals.
 *
 * Why re-frame instead of forwarding Eve verbatim:
 *  - A frame carries the run id, so a tab with several chats can route frames.
 *  - Deltas are tagged with the block they belong to, so a reconnect that
 *    replays a coalesced delta cannot duplicate text.
 *  - Protocol churn (v21..v26) stays behind this seam rather than reaching
 *    components.
 */

/** One normalized frame the proxy writes to the browser. */
export type ChatFrame =
  /** The reply so far, in full. Sent once at the head of a stream and after reconnect. */
  | { type: "snapshot"; runId: string; blocks: ChatBlock[]; cursor: number }
  /** A delta appended to the block `blockId`. Idempotent by `(blockId, cursor)`. */
  | { type: "delta"; runId: string; blockId: string; text: string; cursor: number }
  /** A block finished; `text` is authoritative and replaces anything accumulated. */
  | { type: "block"; runId: string; blockId: string; text: string; finishReason: string | null; cursor: number }
  /** A tool call started or settled. `label` is the human-readable name. */
  | { type: "tool"; runId: string; callId: string; label: string; status: "running" | "ok" | "error"; cursor: number }
  /** The person's own message, replayed from the durable stream so a reload keeps it. */
  | { type: "message"; runId: string; role: "user"; text: string; cursor: number }
  /** Citations a tool produced; `onCitation` on the surface receives these. */
  | { type: "citations"; runId: string; citations: ChatCitation[]; cursor: number }
  /** The turn ended. `state` mirrors the run row, not Eve's turn vocabulary. */
  | { type: "turn"; runId: string; state: "waiting" | "completed" | "failed" | "cancelled"; cursor: number }
  /** The run reached a terminal state. No further frames follow. */
  | { type: "end"; runId: string; state: "succeeded" | "failed" | "cancelled"; cursor: number }
  /** A transport-level problem the surface should show, not crash on. */
  | { type: "error"; runId: string; code: ChatErrorCode; message: string; cursor: number };

export type ChatErrorCode =
  | "run_finished"
  | "run_not_found"
  | "agent_bridge_unavailable"
  | "stream_unavailable";

/**
 * A citation as the chat surface sees it. Deliberately the same fields as
 * `DocumentCitation` (src/domains/knowledge/agent-search.ts) so
 * `onCitation` can pass it straight through — the surface does not own a
 * second citation type.
 */
export type ChatCitation = {
  documentId: string;
  title: string;
  text: string;
  span: { start: number; end: number; page: number | null };
};

export type ChatBlock = {
  id: string;
  kind: "assistant" | "reasoning" | "user";
  text: string;
  done: boolean;
};

/**
 * The smallest shape the fold needs from an Eve stream event. Declared here
 * rather than importing from `eve` so the contract stays dependency-free and can
 * run in the browser bundle without pulling the SDK in.
 */
export type EveEvent = {
  type: string;
  data?: Record<string, unknown>;
  meta?: { id?: string };
};

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * Citation extraction for a tool output, inline rather than imported from the
 * knowledge domain: this module must stay dependency-free so it can ship in the
 * browser bundle and run in the eval harness. The shape it reads is
 * `DocumentCitation`, and `collectCitations` in
 * src/domains/knowledge/agent-search.ts is the canonical server-side version —
 * keep the two in step when the citation shape changes.
 */
function citationsFromToolOutput(output: unknown): ChatCitation[] {
  const list = (output as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  for (const item of list) {
    const candidate = item as Partial<ChatCitation>;
    if (
      typeof candidate.documentId !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.text !== "string"
    ) {
      continue;
    }
    const start = candidate.span?.start ?? 0;
    const key = `${candidate.documentId}:${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId: candidate.documentId,
      title: candidate.title,
      text: candidate.text,
      span: { start, end: candidate.span?.end ?? start, page: candidate.span?.page ?? null },
    });
  }
  return out;
}

/**
 * The block a delta belongs to. Eve keeps appends and the matching completion
 * together by stream coordinates (turn, step) plus type; two assistant blocks in
 * one turn come from two steps, so stepIndex is part of the identity.
 */
function blockIdFor(data: Record<string, unknown>, kind: "assistant" | "reasoning"): string {
  const turnId = asString(data.turnId) ?? "t";
  const stepIndex = asNumber(data.stepIndex) ?? 0;
  return `${kind}:${turnId}:${stepIndex}`;
}

/**
 * Fold one Eve event into zero or more frames.
 *
 * Returns an empty array for events the surface does not render (session
 * lifecycle, usage, compaction). Returning [] rather than null keeps the caller
 * a flat map.
 */
export function frameOf(runId: string, event: EveEvent, cursor: number): ChatFrame[] {
  const data = event.data ?? {};
  switch (event.type) {
    case "message.appended": {
      const text = asString(data.messageDelta);
      if (text === null || text.length === 0) return [];
      return [{ type: "delta", runId, blockId: blockIdFor(data, "assistant"), text, cursor }];
    }
    case "reasoning.appended": {
      const text = asString(data.reasoningDelta);
      if (text === null || text.length === 0) return [];
      return [{ type: "delta", runId, blockId: blockIdFor(data, "reasoning"), text, cursor }];
    }
    case "message.completed": {
      const text = asString(data.message);
      if (text === null) return [];
      const blockId = blockIdFor(data, "assistant");
      return [
        {
          type: "block",
          runId,
          blockId,
          text,
          finishReason: asString(data.finishReason),
          cursor,
        },
      ];
    }
    case "reasoning.completed": {
      const text = asString(data.reasoning);
      if (text === null) return [];
      return [
        {
          type: "block",
          runId,
          blockId: blockIdFor(data, "reasoning"),
          text,
          finishReason: null,
          cursor,
        },
      ];
    }
    case "actions.requested": {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const frames: ChatFrame[] = [];
      for (const action of actions) {
        const a = action as { kind?: string; callId?: string; toolName?: string };
        if (a.kind !== "tool-call" || typeof a.callId !== "string") continue;
        frames.push({
          type: "tool",
          runId,
          callId: a.callId,
          label: a.toolName ?? "tool",
          status: "running",
          cursor,
        });
      }
      return frames;
    }
    case "action.result": {
      const result = (data.result ?? {}) as { toolName?: unknown; callId?: unknown; output?: unknown };
      const callId = asString(result.callId);
      if (callId === null) return [];
      // Only an explicit success counts as ok. "cancelled", "timeout", a missing
      // status, or a status this fold does not know are all failures: rendering
      // an unknown outcome as success would claim an effect that may not have
      // happened, and would emit citations from a partial result.
      const succeeded = data.status === "completed" || data.status === "succeeded";
      const frames: ChatFrame[] = [
        {
          type: "tool",
          runId,
          callId,
          label: asString(result.toolName) ?? "tool",
          status: succeeded ? "ok" : "error",
          cursor,
        },
      ];
      // A search result carries the passages an answer cites. Emitting them as
      // their own frame is what lets the surface call onCitation; without this
      // the citation list would never fill.
      if (succeeded) {
        const citations = citationsFromToolOutput(result.output);
        if (citations.length > 0) frames.push({ type: "citations", runId, citations, cursor });
      }
      return frames;
    }
    case "message.received": {
      // The durable stream replays the person's turn, so a reload shows the
      // question as well as the answer instead of an orphaned reply.
      const text = asString(data.message);
      if (text === null || text.length === 0) return [];
      return [{ type: "message", runId, role: "user", text, cursor }];
    }
    case "turn.completed":
      return [{ type: "turn", runId, state: "completed", cursor }];
    case "turn.failed":
      return [{ type: "turn", runId, state: "failed", cursor }];
    case "turn.cancelled":
      return [{ type: "turn", runId, state: "cancelled", cursor }];
    case "session.waiting":
      // The session can take another message: the turn is not the end of the run.
      return [{ type: "turn", runId, state: "waiting", cursor }];
    case "session.completed":
      return [{ type: "end", runId, state: "succeeded", cursor }];
    case "session.failed":
      return [{ type: "end", runId, state: "failed", cursor }];
    default:
      return [];
  }
}

/**
 * Accumulate a reply from frames. Pure and order-tolerant: a `block` frame sets
 * authoritative text, a `delta` appends, and a delta whose cursor was already
 * applied is ignored. That last rule is what makes reconnect safe — Eve may
 * replay a coalesced delta, and the surface must not double-render it.
 */
export class ChatAccumulator {
  private readonly blocks = new Map<string, ChatBlock>();
  private readonly seen = new Set<string>();

  apply(frame: ChatFrame): void {
    if (frame.type === "delta") {
      // (blockId, cursor) is the idempotency key for a replayed delta.
      const key = `d:${frame.blockId}:${frame.cursor}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const existing = this.blocks.get(frame.blockId);
      if (existing) existing.text += frame.text;
      else this.blocks.set(frame.blockId, { id: frame.blockId, kind: this.kindOf(frame.blockId), text: frame.text, done: false });
      return;
    }
    if (frame.type === "block") {
      // Authoritative: replaces whatever deltas accumulated.
      this.blocks.set(frame.blockId, {
        id: frame.blockId,
        kind: this.kindOf(frame.blockId),
        text: frame.text,
        done: true,
      });
      return;
    }
    if (frame.type === "message") {
      // Keyed by cursor: a replayed turn writes the same id, so the question
      // does not appear twice after a reconnect.
      const id = `user:${frame.cursor}`;
      if (this.blocks.has(id)) return;
      this.blocks.set(id, { id, kind: "user", text: frame.text, done: true });
      return;
    }
    if (frame.type === "snapshot") {
      this.blocks.clear();
      for (const block of frame.blocks) this.blocks.set(block.id, { ...block });
    }
  }

  /** Assistant and reasoning blocks, in insertion order, as the surface renders them. */
  list(): ChatBlock[] {
    return [...this.blocks.values()];
  }

  /** The visible assistant text: reasoning stays separate so a surface can collapse it. */
  assistantText(): string {
    return this.list()
      .filter((block) => block.kind === "assistant")
      .map((block) => block.text)
      .join("");
  }

  private kindOf(blockId: string): ChatBlock["kind"] {
    if (blockId.startsWith("reasoning:")) return "reasoning";
    if (blockId.startsWith("user:")) return "user";
    return "assistant";
  }
}

/**
 * The byte-level framing the proxy writes and the client store reads: one JSON
 * frame per NDJSON line. Shared so the two ends cannot drift.
 */
export function encodeFrame(frame: ChatFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parse one NDJSON line; null for a blank line or a line that is not a frame. */
/** Frame types that carry no state and only report activity. */
const STATELESS_FRAMES = new Set(["tool", "turn", "citations", "end", "error"]);

/**
 * Parse one NDJSON line into a frame, or null.
 *
 * Validates the discriminant and the fields the accumulator and the hook read.
 * A shape check on `type`/`runId` alone was not enough: a `delta` without a
 * cursor made `Math.max(cursor, undefined)` NaN, the client sent
 * `x-chat-cursor: NaN`, and the route read it back as 0 — forcing a full replay
 * on every reconnect. A `delta` without a blockId would silently append to
 * nothing.
 */
export function decodeFrame(line: string): ChatFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed.type !== "string" || typeof parsed.runId !== "string") return null;
  if (!STATELESS_FRAMES.has(parsed.type) && parsed.type !== "delta" && parsed.type !== "block" && parsed.type !== "message" && parsed.type !== "snapshot") {
    // An unknown frame type is protocol skew. Dropping it silently is correct
    // for forward compatibility; the caller sees no state change.
    return null;
  }
  if (typeof parsed.cursor !== "number" || !Number.isFinite(parsed.cursor)) return null;
  if (parsed.type === "delta" && (typeof parsed.blockId !== "string" || typeof parsed.text !== "string")) return null;
  if (parsed.type === "block" && typeof parsed.blockId !== "string") return null;
  if (parsed.type === "message" && typeof parsed.text !== "string") return null;
  if (parsed.type === "snapshot" && !Array.isArray(parsed.blocks)) return null;
  return parsed as unknown as ChatFrame;
}

/** Split a buffer into complete lines plus the unterminated remainder. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}
