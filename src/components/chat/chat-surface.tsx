"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, ChevronDown, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { useChatStream, type ChatState } from "./use-chat-stream";
import { toolGlyph } from "./provider-icon";
import { makePending, stillPending, type PendingMessage } from "./pending-messages";

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
  type: "dossier" | "document" | "artifact";
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
};

export function ChatSurface({
  runId,
  subject,
  optimisticMessage,
  placeholder = "Ask about this",
  composerLabel = "Message",
  emptyText,
  onCitation,
  title,
  showHeader = true,
  className,
}: ChatSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set by a send: the owner's own message always scrolls into view, even when
  // they had scrolled up to reread something.
  const forceScrollRef = useRef(false);
  const chat = useChatStream(runId, { onCitation });
  const busy = chat.connection === "connecting" || chat.connection === "streaming";
  // Reasoning is available in chat.blocks for a surface that wants it, but the
  // default transcript shows the conversation: questions and answers.
  const transcript = chat.blocks.filter((block) => block.kind === "user" || block.kind === "assistant");
  /*
   * The message the owner just sent but the stream has not echoed. Shown until
   * the server's own copy arrives, matched on text so the two never both render:
   * a duplicate question reads as a double send.
   */
  const optimistic =
    optimisticMessage && !transcript.some((block) => block.kind === "user" && block.text === optimisticMessage)
      ? optimisticMessage
      : null;
  const userTexts = transcript.filter((block) => block.kind === "user").map((block) => block.text);
  const waiting = stillPending(pending, userTexts);
  const lastAssistantIndex = transcript.map((b) => b.kind).lastIndexOf("assistant");

  const lastText = transcript[lastAssistantIndex]?.text;

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
        {transcript.length === 0 && !optimistic && waiting.length === 0 && (!busy || emptyText) ? (
          <p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {emptyText ??
              `Ask a question. Answers cite the ${subject.type === "dossier" ? "pinned sources" : "sources"} they use.`}
          </p>
        ) : (
          <div className="space-y-4">
            {transcript.map((block) =>
              block.kind === "user" ? (
                <div key={block.id} className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] leading-6">
                  {block.text}
                </div>
              ) : (
                <div key={block.id} className="max-w-[72ch] text-[13px] leading-6">
                  <Markdown text={block.text} />
                </div>
              ),
            )}
            {optimistic ? (
              <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] leading-6">
                {optimistic}
              </div>
            ) : null}
            {waiting.map((entry) => (
              <div key={entry.id} className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] leading-6 opacity-70">
                {entry.text}
              </div>
            ))}
          </div>
        )}

        <ToolActivity tools={chat.tools} busy={busy} />

        {chat.citations.length > 0 && (
          <details className="group mt-3 rounded-xl border border-border text-[12px]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <BookOpen aria-hidden className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium text-foreground/80">Sources · {chat.citations.length}</span>
              <span className="min-w-0 flex-1 truncate group-open:hidden">
                {chat.citations.map((citation) => citation.title).join(", ")}
              </span>
              <ChevronDown aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <ul className="space-y-2 border-t border-border px-3 py-2" aria-label="Citations">
              {chat.citations.map((citation) => (
                <li key={`${citation.documentId}:${citation.span.start}`}>
                  <p className="font-medium">{citation.title}</p>
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

      {chat.connection === "done" ? (
        // A finished run refuses follow-ups (409 run_finished): no dead input,
        // just the honest ended state. Continuation is the page's own
        // affordance (Retry on a run, New conversation on a notebook).
        <p className="rounded-2xl border border-border bg-muted/40 px-3.5 py-3 text-[13px] text-muted-foreground">
          This conversation has ended.
        </p>
      ) : (
      <form
        className="rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label={composerLabel}
          className="composer-input max-h-48 min-h-[52px] resize-none rounded-none border-0 bg-transparent px-3.5 py-3 text-[13px] shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME candidate (Japanese, Chinese, Korean) is
            // not a send.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {sendError && (
          <p role="alert" className="px-3.5 pb-1 text-[12px] text-destructive">
            {sendError}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <span className="px-1 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
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
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void fetch(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      }}
    >
      <Square aria-hidden />
      Stop
    </Button>
  );
}

const INTERNAL_TOOLS = /^(eve__|search_models|search_registry|notebook_open)/;
const TOOL_LABELS: Array<[RegExp, string]> = [
  [/tasks_recent/i, "Checked completed tasks"],
  [/tasks_read|tasks\./i, "Checked open tasks"],
  [/documents_search|documents\./i, "Searched your documents"],
  [/wiki_read|wiki\./i, "Checked the wiki"],
  [/wiki_ingest/i, "Updated the wiki"],
  [/wiki_lint/i, "Wiki health check"],
  [/gmail/i, "Checked Gmail"],
  [/calendar/i, "Checked calendar"],
  [/web_search/i, "Searched the web"],
  [/web_fetch/i, "Read a web page"],
];

const toolLabel = (raw: string) => TOOL_LABELS.find(([re]) => re.test(raw))?.[1] ?? raw.replace(/_/g, " ");

/*
 * Tool activity, said the way a good chat product says it: one quiet pill that
 * names what the assistant did, expandable to the steps underneath. While a
 * step runs the pill stays open so progress is visible; once every step
 * settles it closes to a single summary line. Internal lookups with nothing
 * to say (a registry search, a self-check) never appear.
 */
function ToolActivity({ tools, busy }: { tools: ChatState["tools"]; busy: boolean }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const visible = tools.filter((tool) => !INTERNAL_TOOLS.test(tool.label));
  if (visible.length === 0) return null;
  const running = visible.filter((tool) => tool.status === "running");
  const expanded = toggled ?? (running.length > 0 || busy);
  const summary =
    running.length > 0
      ? `${toolLabel(running[running.length - 1].label)}…`
      : visible.length === 1
        ? toolLabel(visible[0].label)
        : `Used ${visible.length} tools`;
  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/30 text-[12px]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setToggled(!expanded)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown aria-hidden className={`size-3.5 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        {running.length > 0 ? <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground/60" /> : null}
      </button>
      {expanded ? (
        <ul className="space-y-1 border-t border-border px-3 py-2" aria-label="Tool activity">
          {visible.map((tool) => {
            const Glyph = toolGlyph(tool.label);
            const count = /^\d+$/.test(tool.detail ?? "");
            return (
              <li key={tool.callId} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Glyph aria-hidden className="size-3.5 shrink-0" />
                <span>{toolLabel(tool.label)}</span>
                <span
                  className={tool.status === "error" ? "text-destructive" : tool.status === "ok" ? "text-foreground" : ""}
                >
                  {tool.status === "running"
                    ? "\u2026"
                    : tool.status === "ok"
                      ? count
                        ? `${tool.detail} matches`
                        : ""
                      : (tool.detail ?? "failed")}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
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
