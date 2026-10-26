"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, BookOpen, ChevronDown, Copy, Check, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import type { ChatBlock } from "@/domains/agents/stream-contract";
import { useChatStream } from "./use-chat-stream";
import { makePending, stillPending, type PendingMessage } from "./pending-messages";
import { MessageFeedback } from "./message-feedback";
import { ComposerPlus, mentionAt, replaceMention, type RecordReference } from "./composer-plus";
import { ChainOfThought, type ThoughtStep } from "./chain-of-thought";
import { AgentPanel, type AgentPanelData } from "./agent-panel";
import { Confirmation, type InterruptCard } from "./confirmation";
import { toolLabel } from "./tool-labels";
import { collectRecords } from "./record-links";
import { CitedText } from "./cited-text";
import { inline } from "@/components/markdown-inline";

/**
 * A live assistant block's id is `assistant:{turnId}:{stepIndex}` (see
 * blockIdFor in stream-contract.ts); the run_event it lands in carries the
 * same turnId, so feedback addresses the row through it.
 */
function turnIdOf(blockId: string): string {
  const parts = blockId.split(":");
  return parts.length >= 2 ? parts[1] : blockId;
}

/*
 * ChatSurface — the one chat interface.
 *
 * Every place Polymath asks an agent something mounts this: the notebook pane,
 * a dossier tab, a command surface. It owns rendering, streaming, and the
 * composer; it does not own the run. The caller creates the run
 * (POST /api/v1/runs, idempotent) and hands in the runId, because run creation
 * needs a server-side AuthContext and a spend reservation.
 *
 * The `subject` says what the conversation is about. It is advisory to the
 * surface (what to show in the header) and authoritative to the run (the server
 * already bound the run to it via `subjects`). The surface never re-scopes a run
 * client-side.
 *
 * Streaming is our own route, not Eve's, because every Eve call needs a
 * server-minted 60-second token. See src/app/api/v1/runs/[runId]/stream.
 */

export type ChatSubject = {
  type: "project" | "document" | "artifact";
  id: string;
};

export type ChatSurfaceProps = {
  runId: string;
  subject: ChatSubject;
  /**
   * A message the caller has already sent but the stream has not echoed yet.
   * Without it the first thing the owner writes disappears for the length of a
   * server action plus a stream open, which reads as a dropped keystroke.
   */
  optimisticMessage?: string;
  /**
   * The transcript already stored for this run. A live surface streams Eve, and
   * Eve replays only the current turn, so without this a resumed conversation
   * reads as empty until the next event arrives.
   */
  initial?: ChatBlock[];
  placeholder?: string;
  /** Accessible name for the composer; pages that frame it as a reply pass their own. */
  composerLabel?: string;
  /** Empty-transcript line; pages with a stored record say so instead of prompting. */
  emptyText?: string;
  /** Receives citations a tool produced, as the knowledge domain's own type. */
  onCitation?: (citations: DocumentCitation[]) => void;
  /** Title shown in the surface header; defaults to the subject type. */
  title?: string;
  /**
   * Whether to render the surface's own header row. The run page already names
   * the conversation in its page header, and two headers stacked about 150px of
   * chrome before the first message. Presence is named explicitly rather than
   * inferred from a missing `title` because the title is also the section's
   * accessible name and other callers rely on the subject-type fallback.
   */
  showHeader?: boolean;
  className?: string;
  /** Who is working, shown above the transcript. Server-resolved from the run's frozen snapshot. */
  agent?: AgentPanelData;
  /**
   * What the run is waiting on, when it has stopped for a person. Rendered
   * above the composer so the answer goes where the question already is.
   */
  interrupt?: InterruptCard | null;
  onInterruptAnswer?: (answer: string) => Promise<{ ok: boolean; message?: string }>;
  onInterruptResolve?: (decision: "approved" | "rejected") => Promise<{ ok: boolean; message?: string }>;
  /**
   * Sends into the conversation rather than into this run. The shell passes
   * this when it owns continuity: a finished run has no session, and only the
   * caller knows how to carry the message into a new segment.
   */
  onContinue?: (runId: string, text: string) => Promise<{ ok: true; runId: string } | { ok: false; message: string }>;
};

export function ChatSurface({
  runId,
  subject,
  optimisticMessage,
  initial,
  placeholder = "Ask about this",
  composerLabel = "Message",
  emptyText,
  onCitation,
  title,
  showHeader = true,
  className,
  agent,
  interrupt,
  onInterruptAnswer,
  onInterruptResolve,
  onContinue,
}: ChatSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  // @-mention: the draft and caret yield the token; whitespace closes it.
  const mention = mentionAt(draft, caret);
  const mentionOpen = mention?.open ?? false;
  const mentionQuery = mention?.query ?? "";
  // A first message typed on a surface that navigated here (the Assistant home)
  // crosses via sessionStorage; read once, then clear so a reload never replays it.
  const [crossedMessage] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      const key = `chat-optimistic:${runId}`;
      const value = window.sessionStorage.getItem(key);
      if (value === null) return null;
      window.sessionStorage.removeItem(key);
      return value;
    } catch {
      return null;
    }
  });
  const carried = optimisticMessage ?? crossedMessage;
  const [sending, setSending] = useState(false);
  const router = useRouter();
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [records, setRecords] = useState<RecordReference[] | null | undefined>(undefined);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusQuery, setPlusQuery] = useState("");
  useEffect(() => {
    if (!plusOpen && !mentionOpen) return;
    const query = mentionOpen ? mentionQuery : plusQuery;
    const controller = new AbortController();
    // Fetching lands in the timeout, so every setRecords call is async from
    // React's view — no synchronous setState inside the effect body.
    const timer = setTimeout(() => {
      void fetch(`/api/v1/records/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { records: [] }))
        .then((body: { records?: RecordReference[] }) => setRecords(body.records ?? []))
        .catch(() => setRecords([]));
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [plusOpen, plusQuery, mentionOpen, mentionQuery]);

  function insertReference(markdown: string) {
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${markdown} ` : `${markdown} `));
  }
  // Set by a send: the owner's own message always scrolls into view, even when
  // they had scrolled up to reread something.
  const forceScrollRef = useRef(false);
  const chat = useChatStream(runId, { onCitation, ...(initial?.length ? { initial: { blocks: initial } } : {}) });
  const busy = chat.connection === "connecting" || chat.connection === "streaming";
  // The transcript renders the conversation: questions, answers, and the
  // model's rationale as its own collapsed pill. `transcript` (user/assistant
  // only) still drives optimistic-match, scroll, and pending-message logic.
  const transcript = chat.blocks.filter((block) => block.kind === "user" || block.kind === "assistant");
  /*
   * The message the owner just sent but the stream has not echoed. Shown until
   * the server's own copy arrives, matched on text so the two never both render:
   * a duplicate question reads as a double send.
   */
  const optimistic =
    carried && !transcript.some((block) => block.kind === "user" && block.text === carried)
      ? carried
      : null;
  const userTexts = transcript.filter((block) => block.kind === "user").map((block) => block.text);
  const waiting = stillPending(pending, userTexts);
  const lastAssistantIndex = transcript.map((b) => b.kind).lastIndexOf("assistant");

  const lastText = transcript[lastAssistantIndex]?.text;

  /*
   * The chain of thought for the current turn: every reasoning block and tool
   * call in arrival order, as one collapsible. The answer stays the thing being
   * read; the working is one press away.
   *
   * Tools are keyed by callId and reasoning blocks by their own id, so the list
   * is stable across a reconnect (a replayed frame updates a step in place
   * rather than appending a second copy).
   */
  const steps: ThoughtStep[] = [
    ...chat.blocks
      .filter((block) => block.kind === "reasoning" && block.text.trim() !== "")
      .map(
        (block): ThoughtStep => ({
          id: block.id,
          kind: "reasoning",
          label: block.done ? "Reasoned through the question" : "Reasoning",
          text: block.text,
          status: block.done ? "complete" : "running",
        }),
      ),
    ...chat.tools.map(
      (tool): ThoughtStep => ({
        id: `tool:${tool.callId}`,
        kind: "tool",
        label: toolLabel(tool.label),
        ...(tool.detail ? { detail: tool.detail } : {}),
        status: tool.status === "running" ? "running" : tool.status === "ok" ? "complete" : "error",
        tool: tool.label,
        ...(tool.status !== "running" ? { records: collectRecords(tool.output) } : {}),
      }),
    ),
  ];

  // Keep the newest text in view as it streams, without fighting a reader who
  // has scrolled up: only follow when already near the bottom.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom || forceScrollRef.current) node.scrollTop = node.scrollHeight;
    forceScrollRef.current = false;
  }, [transcript.length, lastText, waiting.length]);

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setSendError(null);
    // Optimistic: the message shows and the composer empties now. A failure
    // below takes it back out and returns the words to the composer, so a
    // failed send never loses what was typed.
    const entry = makePending(crypto.randomUUID(), message, userTexts);
    setPending((current) => [...current, entry]);
    setDraft("");
    forceScrollRef.current = true;
    const restore = (error: string) => {
      setPending((current) => current.filter((item) => item.id !== entry.id));
      setDraft((current) => (current.trim() === "" ? message : current));
      setSendError(error);
    };
    try {
      // `onContinue` is the shell's way of keeping one conversation alive
      // across the runs that implement it: a finished run has no session, so
      // the surface would otherwise dead-end mid-thought. Without the handler
      // this is the plain follow-up the run endpoint serves.
      if (onContinue) {
        const result = await onContinue(runId, message);
        if (!result.ok) {
          restore(result.message);
          return;
        }
        if (result.runId !== runId) {
          // A new segment answered, so this transcript is no longer the head of
          // the conversation; the shell re-renders on the new run.
          router.refresh();
        }
        return;
      }
      const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string; title?: string } | null;
        restore(problem?.detail ?? problem?.title ?? "The message was not sent.");
        return;
      }
    } catch {
      restore("The message was not sent. Check the connection and try again.");
    } finally {
      setSending(false);
    }
  }

  /*
   * Attach captures into the inbox through the same multipart route the
   * command layer uses; the run stays text-only. The hint line reports the
   * outcome so a capture never reads as it joining this conversation.
   */
  function attachFile(file: File) {
    if (file.size > 4 * 1024 * 1024) {
      setAttachNote("Captures are limited to 4 MB - the file was not attached.");
      return;
    }
    setAttachNote(`Capturing ${file.name}…`);
    const form = new FormData();
    form.set("file", file);
    void fetch("/api/v1/captures/file", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: form })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 413) { setAttachNote("That file is over the 4 MB limit."); return; }
          const problem = (await res.json().catch(() => null)) as { title?: string } | null;
          setAttachNote(problem?.title ?? "Could not capture the file. Try again.");
          return;
        }
        setAttachNote(`Captured ${file.name} to your inbox.`);
      })
      .catch(() => setAttachNote("Could not capture the file. Try again."));
  }

  return (
    <section className={`flex min-h-0 flex-col ${className ?? ""}`} aria-label={title ?? `Chat about this ${subject.type}`}>
      {showHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-[13px] font-medium">{title ?? `This ${subject.type}`}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            {chat.connection === "waiting" && <span>Waiting for a message</span>}
            {busy && <span>Working</span>}
            {chat.connection === "done" && <span>Finished</span>}
          </div>
        </header>
      ) : null}

      {/*
       * A page that hides the header still owes the reader the connection
       * state, so it moves to a single quiet line above the transcript rather
       * than vanishing with the chrome it used to share.
       */}
      {!showHeader && (busy || chat.connection === "done") ? (
        <p className="text-muted-foreground pt-1 pb-2 text-[11px]" role="status">
          {busy ? "Working" : "Finished"}
        </p>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4">
        <div className="mt-auto flex min-h-full flex-col justify-end gap-4">
        {agent ? <AgentPanel agent={agent} /> : null}
        {transcript.length === 0 && !optimistic && waiting.length === 0 && (!busy || emptyText) ? (
          <p className="text-muted-foreground max-w-xl text-[13px] leading-relaxed">
            {emptyText ??
              `Ask a question. Answers cite the ${subject.type === "project" ? "pinned sources" : "sources"} they use.`}
          </p>
        ) : (
          <div className="w-full space-y-4">
            {chat.blocks.map((block) =>
              block.kind === "user" ? (
                <div key={block.id} className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-[14px] leading-6">
                  {inline(block.text)}
                </div>
              ) : block.kind === "reasoning" ? null : (
                <div key={block.id} className="group/message w-full font-[family-name:var(--font-reading)] text-[16px] leading-7">
                  {/* A run's citations apply to its answer, so the markers in
                      the prose and the list below resolve in one numbering. */}
                  <CitedText text={block.text} citations={chat.citations} />
                  {block.kind === "assistant" && block.done ? (
                    <MessageToolbar runId={runId} turnId={turnIdOf(block.id)} text={block.text} />
                  ) : null}
                </div>
              ),
            )}
            {optimistic ? (
              <div className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-[14px] leading-6">
                {optimistic}
              </div>
            ) : null}
            {waiting.map((entry) => (
              <div key={entry.id} className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-[14px] leading-6 opacity-70">
                {inline(entry.text)}
              </div>
            ))}
            {/* The working, after the turn's answer: reasoning and tool calls
                as one block rather than a pill per step. */}
            <ChainOfThought steps={steps} streaming={busy} />
          </div>
        )}

        {chat.citations.length > 0 && (
          <details className="group mt-3 rounded-xl border border-border text-[12px]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <BookOpen aria-hidden className="size-3.5 shrink-0" />
              {/* Citations are passages, so one document can back several. The
                  chip names the documents; the count would read as "5 sources"
                  for one document. */}
              <span className="shrink-0 font-medium text-foreground/80">
                Sources · {new Set(chat.citations.map((citation) => citation.documentId)).size}
              </span>
              <span className="min-w-0 flex-1 truncate group-open:hidden">
                {[...new Set(chat.citations.map((citation) => citation.title))].join(", ")}
              </span>
              <ChevronDown aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <ul className="space-y-2 border-t border-border px-3 py-2" aria-label="Citations">
              {chat.citations.map((citation, index) => (
                <li key={`${citation.documentId}:${citation.span.start}`} id={`citation-${index}`} className="scroll-mt-4">
                  {/* The title opens the document at its library route, so a
                      citation is a way into the source rather than a label. */}
                  <Link
                    href={`/alfred/library/${citation.documentId}`}
                    className="font-medium underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
                  >
                    {citation.title}
                  </Link>
                  {/* The passage is evidence for the answer. Chunks arrive
                      mid-sentence, so the line is trimmed to a readable start
                      before clamping. */}
                  <p className="line-clamp-2 text-muted-foreground">{trimPassage(citation.text)}</p>
                </li>
              ))}
            </ul>
          </details>
        )}

        {chat.error && (
          <div role="status" className="mt-3 flex items-center gap-3 text-[12px] text-destructive">
            <p>{chat.error}</p>
            {chat.connection === "error" && chat.retryable ? (
              <Button type="button" size="sm" variant="outline" onClick={chat.retry}>
                Retry
              </Button>
            ) : null}
          </div>
        )}
        </div>
      </div>

      {/*
       * The interrupt sits directly above the composer, not at the top of the
       * page: it is the next thing to do, and the reply that resolves it goes
       * into the box below.
       */}
      {interrupt ? (
        <div className="pb-2">
          <Confirmation
            card={interrupt}
            {...(onInterruptAnswer ? { onAnswer: onInterruptAnswer } : {})}
            {...(onInterruptResolve ? { onResolve: onInterruptResolve } : {})}
          />
        </div>
      ) : null}

      {chat.connection === "done" && !chat.lastFailedTurn ? (
        // A finished run refuses follow-ups (409 run_finished): no dead input,
        // just the honest ended state. Continuation is the page's own
        // affordance (Retry on a run, New conversation on a notebook). A
        // failed turn is NOT this state: the session takes follow-ups, so the
        // stream ending leaves the composer open with the failure alert.
        <p className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-[13px] text-muted-foreground">
          This conversation has ended.
        </p>
      ) : (
      <form
        className="relative rounded-xl border border-border bg-card shadow-sm transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {/*
         * The failure sits above the field, not on it. Absolutely positioned
         * inside the composer it landed on the first line of what the person
         * had just typed, which is the one line they need to reread after a
         * send fails.
         */}
        {sendError && (
          <p role="alert" className="border-b border-border px-3.5 pt-2.5 pb-2 text-[12px] text-destructive">
            {sendError}
          </p>
        )}
        <Textarea
          aria-label={composerLabel}
          className="composer-input max-h-48 min-h-[76px] resize-none rounded-none border-0 bg-transparent px-3.5 pt-3 pb-11 text-[15px] leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            const target = event.currentTarget;
            setCaret(target.selectionStart ?? target.value.length);
          }}
          onKeyDown={(event) => {
            // Enter that confirms an IME candidate (Japanese, Chinese, Korean) is
            // not a send.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {/*
         * The plus sits inside the input's frame, bottom-left, like the send
         * button sits inside it bottom-right: the composer is one surface,
         * not a toolbar under a box.
         */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            <ComposerPlus
              label="Add to message"
              records={records}
              onReference={insertReference}
              onQueryChange={setPlusQuery}
              onOpenChange={(open) => {
                setPlusOpen(open);
                if (!open) setPlusQuery("");
              }}
              onFile={attachFile}
              mention={mention}
              onMentionPick={(record) => {
                if (!mention) return;
                setDraft((current) => replaceMention(current, mention, `[${record.title}](${record.href})`));
              }}
            />
            <span className="px-1 truncate text-[11px] text-muted-foreground">
              {attachNote ?? "Enter to send · Shift+Enter for a new line"}
            </span>
          </div>
          <Button
            type="submit"
            size="icon"
            aria-label={sending ? "Sending" : "Send"}
            title={sending ? "Sending" : "Send"}
            className="size-8 shrink-0 rounded-full"
            disabled={!draft.trim() || sending}
          >
            <ArrowUp aria-hidden className="size-4" />
          </Button>
        </div>
      </form>
      )}
    </section>
  );
}

/** The stop control a surface shows while a turn is live. */
export function ChatCancel({ runId }: { runId: string }) {
  return (
    <button
      type="button"
      className="hover:text-foreground inline-flex items-center gap-1.5 rounded text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      onClick={() => {
        void fetch(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      }}
    >
      <Square aria-hidden className="size-3" />
      Stop
    </button>
  );
}

/*
 * The action toolbar under a finished assistant message: copy, then like and
 * dislike. Icons rest at a quiet muted tone and come forward on hover, so the
 * actions stay discoverable and keyboard-visible (a hover-only reveal would
 * hide them from axe and from keyboard users) without shouting in the
 * transcript.
 */
function MessageToolbar({ runId, turnId, text }: { runId: string; turnId: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A blocked clipboard is not an error the transcript should carry.
    }
  }
  return (
    <div className="mt-1 flex items-center gap-0.5">
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
        className="text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
      <MessageFeedback runId={runId} turnId={turnId} initial={null} />
    </div>
  );
}

/**
 * The model's visible rationale, collapsed the same way tool activity is: a
 * quiet pill that names it, body kept out of the way until asked for.
 */
export function ThinkingPill({ text, done }: { text: string; done: boolean }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3 shrink-0 -rotate-90 transition-transform group-open:rotate-0" />
        {done ? "Thought process" : "Thinking\u2026"}
      </summary>
      <p className="text-muted-foreground mt-1 whitespace-pre-wrap border-l border-border pl-3 text-[13px] leading-6">{text}</p>
    </details>
  );
}

/**
 * A search chunk starts wherever the span started, often mid-word. Trim to the
 * first full word so a citation opens with prose instead of a fragment like
 * "ion patterns of SMBs".
 */
function trimPassage(text: string): string {
  const trimmed = text.trimStart();
  // A fragment begins lowercase or mid-token; drop the partial first word.
  const firstBreak = trimmed.search(/[\s,.;:]/);
  const firstWord = firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak);
  const startsClean = /^[A-Z"“('[]/.test(firstWord) && firstWord.length > 2;
  return startsClean ? trimmed : firstBreak === -1 ? trimmed : trimmed.slice(firstBreak + 1).trimStart();
}
