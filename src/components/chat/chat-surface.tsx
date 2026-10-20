"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { useChatStream } from "./use-chat-stream";
import { toolGlyph } from "./provider-icon";

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
  /** Capabilities the surface advertises; the run's frozen policy is the real gate. */
  capabilities?: string[];
  placeholder?: string;
  /** Receives citations a tool produced, as the knowledge domain's own type. */
  onCitation?: (citations: DocumentCitation[]) => void;
  /** Title shown in the surface header; defaults to the subject type. */
  title?: string;
  className?: string;
};

export function ChatSurface({
  runId,
  subject,
  capabilities = [],
  placeholder = "Ask about this",
  onCitation,
  title,
  className,
}: ChatSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chat = useChatStream(runId, { onCitation });
  const busy = chat.connection === "connecting" || chat.connection === "streaming";
  // Reasoning is available in chat.blocks for a surface that wants it, but the
  // default transcript shows the conversation: questions and answers.
  const transcript = chat.blocks.filter((block) => block.kind === "user" || block.kind === "assistant");
  const lastAssistantIndex = transcript.map((b) => b.kind).lastIndexOf("assistant");

  const lastText = transcript[lastAssistantIndex]?.text;

  // Keep the newest text in view as it streams, without fighting a reader who
  // has scrolled up: only follow when already near the bottom.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [transcript.length, lastText]);

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string; title?: string } | null;
        setSendError(problem?.detail ?? problem?.title ?? "The message was not sent.");
        return;
      }
      setDraft("");
    } catch {
      setSendError("The message was not sent. Check the connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={`flex min-h-0 flex-col ${className ?? ""}`} aria-label={title ?? `Chat about this ${subject.type}`}>
      <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <BookOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <p className="truncate text-[13px] font-medium">{title ?? `This ${subject.type}`}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {chat.connection === "waiting" && <span>Waiting for a message</span>}
          {busy && <span>Working</span>}
          {chat.connection === "done" && <span>Finished</span>}
          {capabilities.length > 0 && <span className="readout">{capabilities.join(" · ")}</span>}
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4">
        {transcript.length === 0 && !busy ? (
          <p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Ask a question. Answers cite the {subject.type === "dossier" ? "pinned sources" : "sources"} they use.
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
          </div>
        )}

        {chat.tools.length > 0 && (
          <ul className="mt-4 space-y-1" aria-label="Tool activity">
            {chat.tools.map((tool) => {
              const Glyph = toolGlyph(tool.label);
              return (
                <li key={tool.callId} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Glyph aria-hidden className="size-3.5 shrink-0" />
                  <span>{tool.label}</span>
                  <span
                    className={
                      tool.status === "ok" ? "text-[#346538]" : tool.status === "error" ? "text-[#9F2F2D]" : ""
                    }
                  >
                    {tool.status === "running" ? "running" : tool.status === "ok" ? "done" : "failed"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {chat.citations.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-border pt-3" aria-label="Citations">
            {chat.citations.map((citation) => (
              <li key={`${citation.documentId}:${citation.span.start}`} className="text-[12px]">
                <p className="font-medium">{citation.title}</p>
                <p className="line-clamp-2 text-muted-foreground">{citation.text}</p>
              </li>
            ))}
          </ul>
        )}

        {chat.error && (
          <p role="status" className="mt-3 text-[12px] text-[#9F2F2D]">
            {chat.error}
          </p>
        )}
      </div>

      <form
        className="border-t border-border pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label="Message"
          className="min-h-[64px] resize-none text-[13px]"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {sendError && (
          <p role="alert" className="mt-2 text-[12px] text-[#9F2F2D]">
            {sendError}
          </p>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Enter sends, Shift+Enter adds a line.</p>
          <Button type="submit" size="sm" disabled={!draft.trim() || sending || chat.connection === "done"}>
            <ArrowUp aria-hidden />
            {sending ? "Sending" : "Send"}
          </Button>
        </div>
      </form>
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
