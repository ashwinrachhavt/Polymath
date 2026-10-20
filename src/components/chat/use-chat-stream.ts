"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChatAccumulator,
  decodeFrame,
  splitLines,
  type ChatBlock,
  type ChatCitation,
} from "@/domains/agents/stream-contract";

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
  tools: { callId: string; label: string; status: "running" | "ok" | "error" }[];
  citations: ChatCitation[];
  connection: ChatConnection;
  error: string | null;
};

const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 400;

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
  }));

  const cursorRef = useRef(options.initial?.cursor ?? 0);
  const accRef = useRef(new ChatAccumulator());
  const onCitationRef = useRef(options.onCitation);
  onCitationRef.current = options.onCitation;

  const flush = useCallback(() => {
    setState((prev) => ({ ...prev, blocks: accRef.current.list() }));
  }, []);

  useEffect(() => {
    if (!runId || options.enabled === false) return;
    let cancelled = false;
    let attempt = 0;
    let controller: AbortController | null = null;

    const connect = async () => {
      if (cancelled) return;
      controller = new AbortController();
      setState((prev) => ({ ...prev, connection: attempt === 0 ? "connecting" : "streaming", error: null }));
      try {
        const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/stream`, {
          headers: { "x-chat-cursor": String(cursorRef.current) },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`stream returned ${response.status}`);
        }
        setState((prev) => ({ ...prev, connection: "streaming" }));
        attempt = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
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
            cursorRef.current = Math.max(cursorRef.current, frame.cursor);
            accRef.current.apply(frame);
            if (frame.type === "citations" && frame.citations.length > 0) {
              setState((prev) => ({ ...prev, citations: frame.citations }));
              onCitationRef.current?.(frame.citations);
            }
            if (frame.type === "tool") {
              setState((prev) => ({
                ...prev,
                tools: mergeTool(prev.tools, { callId: frame.callId, label: frame.label, status: frame.status }),
              }));
            }
            if (frame.type === "turn") {
              setState((prev) => ({ ...prev, connection: frame.state === "waiting" ? "waiting" : prev.connection }));
            }
            if (frame.type === "error") {
              setState((prev) => ({ ...prev, error: frame.message }));
            }
            if (frame.type === "end") {
              terminal = true;
            }
          }
          flush();
          if (terminal) {
            setState((prev) => ({ ...prev, connection: "done" }));
            return;
          }
        }
        // The upstream closed without a terminal frame: a lease ended. Reconnect.
        if (!cancelled) schedule();
      } catch (cause) {
        if (cancelled) return;
        // An abort is our own teardown, not a failure to show.
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        schedule(cause instanceof Error ? cause.message : undefined);
      }
    };

    const schedule = (message?: string) => {
      if (cancelled) return;
      attempt += 1;
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
  }, [runId, options.enabled, flush]);

  return state;
}

function mergeTool(
  tools: ChatState["tools"],
  next: { callId: string; label: string; status: "running" | "ok" | "error" },
): ChatState["tools"] {
  const index = tools.findIndex((tool) => tool.callId === next.callId);
  if (index === -1) return [...tools, next];
  const copy = tools.slice();
  copy[index] = next;
  return copy;
}
