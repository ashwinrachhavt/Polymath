"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChatAccumulator,
  decodeFrame,
  splitLines,
  type ChatBlock,
  type ChatCitation,
} from "@/domains/agents/stream-contract";
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

export type ChatConnection = "connecting" | "streaming" | "waiting" | "done" | "error";

export type ChatState = {
  blocks: ChatBlock[];
  tools: { callId: string; label: string; status: "running" | "ok" | "error"; detail?: string }[];
  citations: ChatCitation[];
  connection: ChatConnection;
  error: string | null;
  /** Whether Retry can help once the connection is in the error state. */
  retryable: boolean;
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
  /** Frames already rendered before this hook mounted (a server-rendered thread). */
  initial?: { blocks?: ChatBlock[]; cursor?: number };
  /** Called once per distinct citation batch, so a surface can highlight a source. */
  onCitation?: (citations: ChatState["citations"]) => void;
  /** Disable the connection (for example while a run row is still being created). */
  enabled?: boolean;
};

export function useChatStream(runId: string | null, options: UseChatStreamOptions = {}) {
  const [state, setState] = useState<ChatState>(() => ({
    blocks: options.initial?.blocks ?? [],
    tools: [],
    citations: [],
    connection: runId && options.enabled !== false ? "connecting" : "waiting",
    error: null,
    retryable: true,
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
    accRef.current.apply({ type: "snapshot", runId: runId ?? "", blocks: options.initial.blocks, cursor: cursorRef.current });
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
      controller = new AbortController();
      setState((prev) => ({ ...prev, connection: "connecting", error: null, retryable: true }));
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
            if (frame.type === "tool") {
              setState((prev) => ({
                ...prev,
                tools: mergeTool(prev.tools, {
                  callId: frame.callId,
                  label: frame.label,
                  status: frame.status,
                  detail: frame.detail,
                }),
              }));
            }
            if (frame.type === "turn") {
              setState((prev) => ({ ...prev, connection: frame.state === "waiting" ? "waiting" : prev.connection }));
              // A failed turn ends this conversation: the session's turn is
              // over and the run row may still say "running" (the bridge
              // closes on session events, which may never come). Keep the
              // composer closed instead of inviting a follow-up that 409s.
              if (frame.state === "failed") {
                setState((prev) => ({ ...prev, connection: "done" }));
                terminal = true;
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
            }
          }
          scheduleFlush();
          if (terminal) {
            setState((prev) => ({ ...prev, connection: "done" }));
            return;
          }
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
      setState((prev) => ({ ...prev, connection: "connecting", error: message ?? prev.error }));
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
  }, [runId, options.enabled, scheduleFlush, retryKey]);

  return { ...state, retry };
}

function mergeTool(
  tools: ChatState["tools"],
  next: { callId: string; label: string; status: "running" | "ok" | "error"; detail?: string },
): ChatState["tools"] {
  const index = tools.findIndex((tool) => tool.callId === next.callId);
  if (index === -1) return [...tools, next];
  // A settled frame replaces the running one wholesale; its `detail` (or its
  // absence) is the outcome, never a leftover from the running frame.
  const copy = tools.slice();
  copy[index] = next;
  return copy;
}
