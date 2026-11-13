"use client";

import { useMemo } from "react";

import dynamic from "next/dynamic";
import { isDiagramTool, diagramCardStates } from "@/domains/diagrams/card-state";
import { Button } from "@/components/ui/button";
import { CitedText } from "./cited-text";
import { AgentSteps, type StepRow } from "./agent-steps";
import { CitationStrip } from "./citation-strip";
import { MessageActions } from "./message-actions";
import { inline } from "@/components/markdown-inline";
import { stripMentionContext } from "./mention-context";
import { AgentPanel, type AgentPanelData } from "./agent-panel";
import type { PendingMessage } from "./pending-messages";
import type { ChatConnection, ChatState } from "./use-chat-stream";
import type { ChatCitation } from "@/domains/agents/stream-contract";
import { reasoningStepRow, toolStepRow } from "./step-rows";
import type { ChatRating, RatedOutput, Rating } from "@/domains/feedback/ratings";

// The diagram card is a heavy island: ssr:false keeps its chrome out of the
// server bundle, matching the canvas.tsx convention. The card itself carries
// no heavy library — render.ts lazy-imports mermaid and the converter inside
// its own functions — so a transcript without diagrams loads zero diagram
// bytes.
const DiagramCard = dynamic(() => import("./diagram-card"), {
  ssr: false,
  loading: () => <div className="panel h-24 rounded-xl" aria-hidden />,
});

/** The model turn a block belongs to: `assistant:<turnId>:<step>` / `reasoning:<turnId>:<step>` (stream-contract blockIdFor). */
function turnOfBlock(block: ChatState["blocks"][number]): string | null {
  if (block.kind === "user") return null;
  const [, turnId] = block.id.split(":");
  return turnId && turnId !== "stored" && turnId !== "t" ? turnId : null;
}

type TurnCard = { turnId: string | null; steps: StepRow[] };

/*
 * The step cards, one per model turn: the turn's visible reasoning, then its
 * tool calls in arrival order. Diagram calls are left out — they render as
 * cards of their own. Steps are keyed by callId and reasoning by block id, so
 * a replayed frame updates a row in place instead of appending a copy.
 */
function turnCards(blocks: ChatState["blocks"], tools: ChatState["tools"]): TurnCard[] {
  const cards = new Map<string | null, StepRow[]>();
  const add = (turnId: string | null, row: StepRow) => cards.set(turnId, [...(cards.get(turnId) ?? []), row]);
  for (const block of blocks) {
    if (block.kind !== "reasoning" || block.text.trim() === "") continue;
    add(turnOfBlock(block), reasoningStepRow(block.id, block.text, block.done));
  }
  for (const tool of tools) {
    if (isDiagramTool(tool)) continue;
    add(tool.turnId ?? null, toolStepRow(tool));
  }
  return [...cards].map(([turnId, steps]) => ({ turnId, steps }));
}

/** Where a block's rating is addressed: a stored reply by sequence, a streamed one by its turn. */
function ratedReply(runId: string, blockId: string): RatedOutput {
  const [, second, third] = blockId.split(":");
  if (second === "stored") return { surface: "chat", runId, sequence: Number(third) };
  return { surface: "chat", runId, turnId: second ?? blockId };
}

function ratingFor(ratings: ChatRating[], output: RatedOutput): Rating | null {
  if (output.surface !== "chat") return null;
  const match =
    output.sequence !== undefined
      ? ratings.find((rating) => rating.sequence === output.sequence)
      : ratings.find((rating) => rating.turnId === output.turnId);
  return match ? { score: match.score, comment: match.comment } : null;
}

/**
 * The conversation column of the chat surface: transcript, working (chain of
 * thought), Sources strip, and stream error line. Pure presentation, in props.
 */
export function ChatTranscript({
  agent,
  blocks,
  tools,
  ratings = [],
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
  /** Tool calls streamed or recorded; each turn's feed its step card. */
  tools: ChatState["tools"];
  /** The viewer's own ratings of this run's replies. */
  ratings?: ChatRating[];
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
  const cards = useMemo(() => turnCards(blocks, tools), [blocks, tools]);
  const diagramCards = useMemo(() => diagramCardStates(tools), [tools]);
  // A turn's card renders above the first block of that turn; a turn with no
  // block yet (the agent is still searching) and steps with no turn render at
  // the end, where the next answer will appear.
  // Each turn's anchor is the id of its first block.
  const anchorOfTurn = new Map<string, string>();
  for (const block of blocks) {
    const turnId = turnOfBlock(block);
    if (turnId !== null && !anchorOfTurn.has(turnId)) anchorOfTurn.set(turnId, block.id);
  }
  const cardByTurn = new Map(cards.filter((card) => card.turnId !== null).map((card) => [card.turnId, card]));
  const trailingCards = cards.filter((card) => card.turnId === null || !anchorOfTurn.has(card.turnId));
  const lastTurn = blocks.length > 0 ? turnOfBlock(blocks[blocks.length - 1]) : null;
  // A turn can stream several answer blocks, and a rating addresses the turn's
  // latest reply, so only that last block carries the rating control.
  const lastAnswerOfTurn = new Map<string, string>();
  for (const block of blocks) {
    const turnId = block.kind === "assistant" ? turnOfBlock(block) : null;
    if (turnId !== null) lastAnswerOfTurn.set(turnId, block.id);
  }
  const ratesBlock = (block: ChatState["blocks"][number]) => {
    const turnId = turnOfBlock(block);
    return turnId === null || lastAnswerOfTurn.get(turnId) === block.id;
  };
  const cardBefore = (block: ChatState["blocks"][number]) => {
    const turnId = turnOfBlock(block);
    if (turnId === null || anchorOfTurn.get(turnId) !== block.id) return null;
    const card = cardByTurn.get(turnId);
    return card ? (
      <AgentSteps
        key={`steps:${turnId}`}
        steps={card.steps}
        active={busy && trailingCards.length === 0 && turnId === lastTurn}
      />
    ) : null;
  };

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
          {blocks.map((block) => [
            cardBefore(block),
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
                    {...(ratesBlock(block)
                      ? { rated: ratedReply(runId, block.id), rating: ratingFor(ratings, ratedReply(runId, block.id)) }
                      : {})}
                    text={block.text}
                    messageId={block.messageId ?? null}
                  />
                ) : null}
              </div>
            ),
          ])}
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
          {trailingCards.map((card) => (
            <AgentSteps key={`steps:${card.turnId ?? "unplaced"}`} steps={card.steps} active={busy} />
          ))}
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
