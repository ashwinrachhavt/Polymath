"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChatAccumulator,
  decodeFrame,
  splitLines,
  type ChatBlock,
  type ChatCitation,
} from "@/domains/agents/stream-contract";
import { mergeStepFacts, type RecordedStep, type StepFacts } from "@/domains/agents/agent-steps";
import { StreamHttpError, describeStreamFailure } from "./stream-errors";

/*
 * The browser half of the chat stream.
 *
 * It reads NDJSON ChatFrames from /api/v1/runs/:runId/stream, keeps the reply
 * in a ChatAccumulator, and reconnects from the last cursor it applied. It is a
 * hook rather than a component so every surface — a notebook pane, a dossier
 * tab, a command palette — gets the same transport by mounting the same thing.
 *
 * Reconnect policy: the durable stream means a dropped connection is a pause,
 * not a loss. We reconnect with backoff while the run is live and stop once a
 * terminal frame arrives. There is no polling and no second source of truth.
 */

/**
 * The transport's own state. "reconnecting" is a drop being retried — the
 * reconnect-pause: the durable stream keeps the run's events, so the surface
 * reads the pause as a pause, never as the run's failure.
 */
export type ChatConnection = "connecting" | "streaming" | "waiting" | "reconnecting" | "done" | "error";

export type ChatState = {
  blocks: ChatBlock[];
  tools: {
    callId: string;
    label: string;
    status: "running" | "ok" | "error";
    detail?: string;
    /** The call's arguments (running frame), then the result payload (settled frame). */
    input?: unknown;
    output?: unknown;
    /** The model turn the call ran in; the step card sits beside that turn's answer. */
    turnId?: string;
    /** Query and sources, merged across the running and settled frames. */
    facts?: StepFacts;
  }[];
  citations: ChatCitation[];
  connection: ChatConnection;
  error: string | null;
  /** Whether Retry can help once the connection is in the error state. */
  retryable: boolean;
  /**
   * The latest turn failed but the session continues: the surface shows the
   * failure alert and keeps the composer open, instead of reading the ended
   * stream state as "this conversation has ended".
   */
  lastFailedTurn: boolean;
  /**
   * The run itself failed terminally — the stream's `end` frame arrived with
   * state "failed", which only a `run.failed` event produces. The run row is
   * failed and its session is closed, so a follow-up message 409s; the
   * surface says so and offers the caller's fresh-start action if it has one.
   */
  runFailed: boolean;
};

const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 400;
/**
 * Consecutive failures with no delivered event before the surface gives up and
 * shows a terminal error. A lease reconnect always arrives after events, so it
 * never reaches this; a 404 or 503 that never yields a frame stops here instead
 * of retrying forever.
 */
const MAX_ATTEMPTS = 5;

export type UseChatStreamOptions = {
  /**
   * Frames already rendered before this hook mounted (a server-rendered
   * thread), and the run's recorded tool calls so a reload keeps its steps.
   */
  initial?: { blocks?: ChatBlock[]; steps?: RecordedStep[]; cursor?: number };
  /** Called once per distinct citation batch, so a surface can highlight a source. */
  onCitation?: (citations: ChatState["citations"]) => void;
  /** Disable the connection (for example while a run row is still being created). */
  enabled?: boolean;
};

export function useChatStream(runId: string | null, options: UseChatStreamOptions = {}) {
  const [state, setState] = useState<ChatState>(() => ({
    blocks: options.initial?.blocks ?? [],
    tools: (options.initial?.steps ?? []).map((step) => ({ ...step })),
    citations: [],
    connection: runId && options.enabled !== false ? "connecting" : "waiting",
    error: null,
    retryable: true,
    lastFailedTurn: false,
    runFailed: false,
  }));

  // Bumped by retry(): a new value restarts the connection effect with a fresh
  // failure count, so a stream that gave up can be reopened without a reload.
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => setRetryKey((key) => key + 1), []);

  const cursorRef = useRef(options.initial?.cursor ?? 0);
  const accRef = useRef(new ChatAccumulator());
  // Seed the accumulator with the server-rendered thread. Without this the
  // first frame's flush() replaces state.blocks with the accumulator's own
  // (empty) contents and the initial transcript disappears.
  const seededRef = useRef(false);
  if (!seededRef.current && options.initial?.blocks?.length) {
    seededRef.current = true;
    accRef.current.apply({
      type: "snapshot",
      runId: runId ?? "",
      blocks: options.initial.blocks,
      cursor: cursorRef.current,
    });
  }
  const onCitationRef = useRef(options.onCitation);
  onCitationRef.current = options.onCitation;

  const flush = useCallback(() => {
    setState((prev) => ({ ...prev, blocks: accRef.current.list() }));
  }, []);

  /*
   * One flush per animation frame, not one per network chunk. A burst of deltas
   * coalesces into a single render, so text flows instead of strobing; the
   * trailing flush guarantees the final chunk lands even if the tab is
   * backgrounded and rAF stops firing.
   */
  const flushScheduled = useRef(false);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    requestAnimationFrame(() => {
      flushScheduled.current = false;
      flushRef.current();
    });
  }, []);

  useEffect(() => {
    if (!runId || options.enabled === false) return;
    let cancelled = false;
    // Consecutive failures, not total attempts: a stream that opens and then
    // drops (a renewable lease) must reset this, or a long conversation would
    // eventually give up on a healthy connection.
    let attempt = 0;
    let controller: AbortController | null = null;

    const connect = async () => {
      if (cancelled) return;
      let turnWaiting = false;
      controller = new AbortController();
      // A re-attempt inside the ladder is a reconnect — the paused transport —
      // while a fresh effect's first attempt is a plain attach.
      setState((prev) => ({
        ...prev,
        connection: attempt === 0 ? "connecting" : "reconnecting",
        error: null,
        retryable: true,
      }));
      try {
        const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/stream`, {
          headers: { "x-chat-cursor": String(cursorRef.current) },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new StreamHttpError(response.status);
        }
        setState((prev) => ({ ...prev, connection: "streaming" }));

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sawEvent = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { lines, rest } = splitLines(buffer);
          buffer = rest;
          let terminal = false;
          // The end frame carries the run's terminal state; only "failed"
          // changes what the surface may promise the reader, and its reason
          // replaces the generic line when Eve supplied one.
          let endState: "succeeded" | "failed" | "cancelled" | null = null;
          let endError: string | null = null;
          for (const line of lines) {
            const frame = decodeFrame(line);
            if (!frame) continue;
            sawEvent = true;
            // A delivered event proves the connection works; the next drop
            // should back off from the base delay again.
            attempt = 0;
            cursorRef.current = Math.max(cursorRef.current, frame.cursor);
            accRef.current.apply(frame);
            if (frame.type === "citations" && frame.citations.length > 0) {
              setState((prev) => ({ ...prev, citations: frame.citations }));
              onCitationRef.current?.(frame.citations);
            }
            if (frame.type === "run") {
              // The connection's head frame: the run's durable stage facts.
              // A failed row is terminal truth — states never un-fail, so the
              // pin is monotone. lastTurnFailed is the durable
              // newest-turn-boundary fact; a newer connection's frame may
              // legitimately clear a stale one (the person followed up while
              // this tab was away), exactly as the panel supersedes a failed
              // ticket once the person speaks again.
              setState((prev) => ({
                ...prev,
                runFailed: prev.runFailed || frame.state === "failed",
                lastFailedTurn: frame.lastTurnFailed,
              }));
            }
            if (frame.type === "message" && frame.role === "user") {
              // The person's own words are the one live fact that supersedes a
              // failed turn: the next turn now owns the stage, so the failed
              // vocabulary yields (the panel drops person-failed the same way).
              turnWaiting = false;
              setState((prev) => ({
                ...prev,
                connection: "streaming",
                ...(prev.lastFailedTurn ? { lastFailedTurn: false } : {}),
              }));
            }
            if (frame.type === "tool") {
              setState((prev) => ({
                ...prev,
                tools: mergeTool(prev.tools, {
                  callId: frame.callId,
                  label: frame.label,
                  status: frame.status,
                  detail: frame.detail,
                  input: frame.input,
                  turnId: frame.turnId,
                  facts: frame.facts,
                }),
              }));
            }
            if (frame.type === "turn") {
              if (frame.state === "waiting" || frame.state === "failed") turnWaiting = true;
              setState((prev) => ({ ...prev, connection: frame.state === "waiting" ? "waiting" : prev.connection }));
              // A failed turn surfaces the failure but does NOT end the
              // conversation: the bridge parks the run at waiting_input and
              // the session still takes follow-ups (eve protocol). The old
              // behaviour — treating the frame as terminal — showed "This
              // conversation has ended" with no error text while the row said
              // waiting_input, and blocked the continuation path. The message
              // state below carries the failure into the surface's alert.
              // The `end` frame that follows a failed turn still terminates
              // the CONNECTION (the stream is over) but the surface reads the
              // lastFailedTurn flag, not the ended state, so the composer
              // stays and the error explains the failed reply.
              if (frame.state === "failed") {
                setState((prev) => ({
                  ...prev,
                  connection: "waiting",
                  error: frame.error
                    ? `The last reply failed: ${frame.error}`
                    : "The last reply failed. You can send another message.",
                  lastFailedTurn: true,
                }));
              }
            }
            if (frame.type === "error") {
              setState((prev) => ({ ...prev, error: frame.message }));
              // These mean retrying cannot help: the run is gone or finished.
              if (frame.code === "run_not_found" || frame.code === "run_finished") {
                setState((prev) => ({ ...prev, connection: "error", retryable: false }));
                return;
              }
            }
            if (frame.type === "end") {
              terminal = true;
              endState = frame.state;
              endError = frame.error ?? null;
            }
          }
          scheduleFlush();
          if (terminal) {
            // A failed turn ends the stream, not the conversation: the error
            // and the open composer survive (chat-surface reads lastFailedTurn
            // before its ended banner). An `end` whose state is "failed" is
            // different in kind — only a run.failed event produces it, so the
            // run row is terminal and its session closed; a follow-up would
            // 409 (run_finished). The turn-failure line promising another
            // message into that run is replaced with the terminal truth, and
            // chat-surface's affordance (or the caller's) owns the recovery.
            if (endState === "failed") {
              setState((prev) => ({
                ...prev,
                connection: "done",
                lastFailedTurn: false,
                runFailed: true,
                // Neutral on purpose: the hook is shared, and only surfaces
                // that wire a fresh-start retry should promise one. Eve's
                // reason, when present, keeps the failure diagnosable without
                // opening the run page.
                error: endError ? `This run failed: ${endError}` : "This run failed.",
                retryable: false,
              }));
            } else {
              setState((prev) => (prev.lastFailedTurn ? prev : { ...prev, connection: "done" }));
            }
            return;
          }
        }
        // A session.waiting event ends this turn but keeps the conversation
        // open. Stay idle until another user message asks us to reconnect.
        if (turnWaiting) {
          setState((prev) => ({ ...prev, connection: "waiting" }));
          return;
        }
        // The upstream closed without a terminal frame: a lease ended. Reconnect.
        if (!cancelled) schedule(sawEvent ? undefined : "The stream closed before a reply.");
      } catch (cause) {
        if (cancelled) return;
        // An abort is our own teardown, not a failure to show.
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const failure = describeStreamFailure(cause);
        // Access and not-found never recover by retrying; say so at once.
        if (!failure.retryable) {
          setState((prev) => ({ ...prev, connection: "error", error: failure.message, retryable: false }));
          return;
        }
        schedule(failure.message);
      } finally {
        // rAF pauses in background tabs; publish the final buffered text on
        // every exit, including terminal frames, parked turns, and drops.
        if (!cancelled) flush();
      }
    };

    const schedule = (message?: string) => {
      if (cancelled) return;
      attempt += 1;
      // A connection that never delivers anything is not a lease expiry; after
      // a few tries, stop and show a terminal error instead of retrying forever
      // against a 404/503.
      if (attempt > MAX_ATTEMPTS) {
        setState((prev) => ({
          ...prev,
          connection: "error",
          error: message ?? "The connection failed.",
          retryable: true,
        }));
        return;
      }
      setState((prev) => ({ ...prev, connection: "reconnecting", error: message ?? prev.error }));
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      timer = window.setTimeout(connect, delay);
    };

    let timer: number | undefined;
    void connect();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
    // runId and enabled are the identity of a stream; options.initial is mount-time.
  }, [runId, options.enabled, scheduleFlush, flush, retryKey]);

  return { ...state, retry };
}

function mergeTool(
  tools: ChatState["tools"],
  next: {
    callId: string;
    label: string;
    status: "running" | "ok" | "error";
    detail?: string;
    input?: unknown;
    turnId?: string;
    facts?: StepFacts;
  },
): ChatState["tools"] {
  const index = tools.findIndex((tool) => tool.callId === next.callId);
  if (index === -1) {
    // A settled frame may arrive without its running twin (a reconnect that
    // skipped the live window): its input is the result payload, not arguments.
    return [...tools, next.status === "running" ? next : { ...next, output: next.input, input: undefined }];
  }
  const copy = tools.slice();
  const prev = tools[index];
  // A settled frame replaces the running one wholesale; its `detail` (or its
  // absence) is the outcome, never a leftover from the running frame. The
  // running frame's `input` (the call arguments) is kept: the settled frame's
  // `input` is the result payload and moves to `output`.
  // A replay of a recorded call (seeded from tool_calls) re-sends its running
  // frame; the settled outcome already on screen must not regress to running.
  if (next.status === "running" && prev.status !== "running") return tools;
  const turnId = next.turnId ?? prev.turnId;
  const facts = mergeStepFacts(prev.facts, next.facts);
  copy[index] =
    next.status === "running"
      ? { ...next, turnId, facts }
      : { ...next, turnId, facts, input: prev.input, output: next.input ?? prev.output };
  return copy;
}
