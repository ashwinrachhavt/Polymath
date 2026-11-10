"use client";

import { useMemo } from "react";

import dynamic from "next/dynamic";
import { isDiagramTool, diagramCardStates } from "@/domains/diagrams/card-state";
import { Button } from "@/components/ui/button";
import { CitedText } from "./cited-text";
import { ChainOfThought, type ThoughtStep } from "./chain-of-thought";
import { CitationStrip } from "./citation-strip";
import { MessageActions } from "./message-actions";
import { inline } from "@/components/markdown-inline";
import { stripMentionContext } from "./mention-context";
import { AgentPanel, type AgentPanelData } from "./agent-panel";
import type { PendingMessage } from "./pending-messages";
import type { ChatConnection, ChatState } from "./use-chat-stream";
import type { ChatCitation } from "@/domains/agents/stream-contract";
import { toolLabel } from "@/domains/agents/tool-labels";
import { collectRecords } from "./record-links";

// The diagram card is a heavy island: ssr:false keeps its chrome out of the
// server bundle, matching the canvas.tsx convention. The card itself carries
// no heavy library — render.ts lazy-imports mermaid and the converter inside
// its own functions — so a transcript without diagrams loads zero diagram
// bytes.
const DiagramCard = dynamic(() => import("./diagram-card"), {
  ssr: false,
  loading: () => <div className="panel h-24 rounded-xl" aria-hidden />,
});

/*
 * The chain of thought for the current turn: every reasoning block and tool
 * call in arrival order, as one collapsible. The answer stays the thing being
 * read; the working is one press away.
 *
 * Tools are keyed by callId and reasoning blocks by their own id, so the list
 * is stable across a reconnect (a replayed frame updates a step in place
 * rather than appending a second copy).
 */
function thoughtSteps(blocks: ChatState["blocks"], tools: ChatState["tools"]): ThoughtStep[] {
  return [
    ...blocks
      .filter((block) => block.kind === "reasoning" && block.text.trim() !== "")
      .map((block): ThoughtStep => ({
        id: block.id,
        kind: "reasoning",
        label: block.done ? "Reasoned through the question" : "Reasoning",
        text: block.text,
        status: block.done ? "complete" : "running",
      })),
    ...tools
      .filter((tool) => !isDiagramTool(tool))
      .map((tool): ThoughtStep => ({
        id: `tool:${tool.callId}`,
        kind: "tool",
        label: toolLabel(tool.label),
        ...(tool.detail ? { detail: tool.detail } : {}),
        status: tool.status === "running" ? "running" : tool.status === "ok" ? "complete" : "error",
        tool: tool.label,
        ...(tool.status !== "running" ? { records: collectRecords(tool.output) } : {}),
      })),
  ];
}

/**
 * A live assistant block's id is `assistant:{turnId}:{stepIndex}` (see
 * blockIdFor in stream-contract.ts); the run_event it lands in carries the
 * same turnId, so feedback addresses the row through it.
 */
function turnIdOf(blockId: string): string {
  const parts = blockId.split(":");
  return parts.length >= 2 ? parts[1] : blockId;
}

/**
 * The conversation column of the chat surface: transcript, working (chain of
 * thought), Sources strip, and stream error line. Pure presentation, in props.
 */
export function ChatTranscript({
  agent,
  blocks,
  tools,
  citations,
  shownCitations,
  runId,
  transcriptEmpty,
  optimistic,
  waiting,
  busy,
  emptyText,
  subjectType,
  error,
  runFailed,
  connection,
  retryable,
  onRetry,
  onRunFailedRetry,
  onRefineDiagram,
}: {
  /** Agent working on the run, shown above the transcript. */
  agent?: AgentPanelData;
  /** Stored and streamed blocks in arrival order. */
  blocks: ChatState["blocks"];
  /** Tool calls streamed this turn; they feed the chain of thought. */
  tools: ChatState["tools"];
  /** Every citation the stream produced; the strip shows the cited ones. */
  citations: ChatCitation[];
  /** The citations the answer actually references, already filtered by the caller. */
  shownCitations: ChatCitation[];
  runId: string;
  /** True when no user or assistant block exists yet; picks the empty line. */
  transcriptEmpty: boolean;
  /** The user's just-sent message, echoed before the stream confirms it. */
  optimistic: string | null;
  /** Optimistic sends still queued after a reconnect. */
  waiting: PendingMessage[];
  busy: boolean;
  /** Empty-transcript line; pages with a stored record say so instead of prompting. */
  emptyText?: string;
  /** What the run is about; the default empty line names its source kind. */
  subjectType: "project" | "document" | "artifact";
  error: string | null;
  runFailed: boolean;
  connection: ChatConnection;
  retryable: boolean;
  onRetry: () => void;
  /** Fresh-start retry for a terminal run; absent where it cannot apply. */
  onRunFailedRetry?: () => void;
  /**
   * Refine-focus for a diagram card: prefills the composer and focuses it.
   * Absent on surfaces without a composer of their own — the card then omits
   * its Refine action rather than promising a composer it cannot reach.
   */
  onRefineDiagram?: (prefill: string) => void;
}) {
  const steps = useMemo(() => thoughtSteps(blocks, tools), [blocks, tools]);
  const diagramCards = useMemo(() => diagramCardStates(tools), [tools]);

  return (
    <div className="mt-auto flex min-h-full flex-col justify-end gap-4">
      {agent ? <AgentPanel agent={agent} /> : null}
      {transcriptEmpty && !optimistic && waiting.length === 0 && (!busy || emptyText) ? (
        <p className="text-muted-foreground max-w-xl text-body-dense leading-relaxed">
          {emptyText ??
            `Ask a question. Answers cite the ${subjectType === "project" ? "pinned sources" : "sources"} they use.`}
        </p>
      ) : (
        <div className="w-full space-y-4">
          {blocks.map((block) =>
            block.kind === "user" ? (
              <div
                key={block.id}
                data-turn-id={block.id}
                data-turn-role="user"
                className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-body leading-6"
              >
                {inline(stripMentionContext(block.text))}
              </div>
            ) : block.kind === "reasoning" ? null : (
              <div
                key={block.id}
                data-turn-id={block.id}
                data-turn-role="assistant"
                className="group/message prose-reading w-full font-[family-name:var(--font-reading)]"
              >
                {/* A run's citations apply to its answer, so the markers in
                  the prose and the list below resolve in one numbering. */}
                <CitedText text={block.text} citations={citations} />
                {block.kind === "assistant" && block.done ? (
                  <MessageActions
                    runId={runId}
                    turnId={turnIdOf(block.id)}
                    text={block.text}
                    messageId={block.messageId ?? null}
                  />
                ) : null}
              </div>
            ),
          )}
          {optimistic ? (
            <div className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-body leading-6">
              {optimistic}
            </div>
          ) : null}
          {waiting.map((entry) => (
            <div
              key={entry.id}
              className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-body leading-6 opacity-70"
            >
              {inline(entry.text)}
            </div>
          ))}
          {/* The working, after the turn's answer: reasoning and tool calls
            as one block rather than a pill per step. Diagram calls are
            excluded from the pills — they render as cards instead. */}
          <ChainOfThought steps={steps} streaming={busy} />
          {diagramCards.map(({ callId, card }) => (
            <DiagramCard key={callId} card={card} onRefine={onRefineDiagram} />
          ))}
        </div>
      )}

      <CitationStrip citations={shownCitations} />

      {error && (
        <div role="status" className="mt-3 flex items-center gap-3 text-label text-destructive">
          {/* Retry guidance lives with the button that delivers it — only a
            surface wired for a fresh-start retry promises one. */}
          <p>
            {error}
            {runFailed && onRunFailedRetry ? " Retry it to start a new run." : ""}
          </p>
          {connection === "error" && retryable ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          {runFailed && onRunFailedRetry ? (
            // The run is terminal — the stream-side retry (chat.retry) would
            // only replay a closed session, so this Retry is the caller's
            // fresh-start action instead.
            <Button type="button" size="sm" variant="outline" onClick={onRunFailedRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
