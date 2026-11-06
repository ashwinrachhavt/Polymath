"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, BookOpen, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import type { ChatBlock } from "@/domains/agents/stream-contract";
import { useChatStream } from "./use-chat-stream";
import { stageChipLabel, stageChipStatus } from "./stage-chip";
import { makePending, stillPending, type PendingMessage } from "./pending-messages";
import { ComposerPlus, mentionAt, referenceLink, replaceMention, type RecordReference } from "./composer-plus";
import { ChatTranscript } from "./chat-transcript";
import type { AgentPanelData } from "./agent-panel";
import { Confirmation, type InterruptCard } from "./confirmation";
import { fetchMentionContext } from "@/app/(workspace)/polymath/mention-actions";
import {
  serializeChips,
  stripMentionContext,
  hasMentionContext,
  type ContextChip,
  type MentionEntity,
} from "./mention-context";
import { ContextChips } from "./context-chips";
import { eventFile, uploadCaptureFile } from "@/lib/capture-upload";
import { citedIndices } from "@/domains/knowledge/inline-citations";

/*
 * ChatSurface — the one chat interface.
 *
 * Every place Polymath asks an agent something mounts this: the notebook pane,
 * a dossier tab, a command surface. It owns streaming, the composer, and
 * assembly — the transcript renders in chat-transcript.tsx, the Sources strip
 * in citation-strip.tsx, the actions in message-actions.tsx. It does not own
 * the run. The caller creates the run
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
  /**
   * The recovery for a run that failed terminally (the stream's end frame said
   * "failed"): rendered as the Retry on the failure line. Only the caller knows
   * how to start a fresh run — a terminal run has no session to retry into —
   * so without this the failure line stands alone and the page's own
   * affordances own the recovery.
   */
  onRunFailedRetry?: () => void;
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
  onRunFailedRetry,
}: ChatSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  // @-mention: the draft and caret yield the token; whitespace closes it.
  const mention = mentionAt(draft, caret);
  // Destructured so the effect below can key on the primitives — the derived
  // object is new every render, and a caret move that keeps the token must
  // not re-open anything.
  const { open: mentionOpen, query: mentionQuery } = mention ?? { open: false, query: "" };
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
  // Records picked as context chips. The context is fetched when the chip is
  // picked — never at send, which only serializes what the chips already
  // fetched — and a chip whose fetch failed blocks the send until it is
  // retried or removed.
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [records, setRecords] = useState<RecordReference[] | null | undefined>(undefined);
  // Diagram refine: a card asks for the composer prefilled and focused.
  // The focus waits a frame so the state-driven draft lands in the textarea
  // before the caret does.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  function refineDiagram(prefill: string) {
    setDraft(prefill);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  // One picker serves both gestures: the plus button toggles menuOpen, and a
  // typed "@" forces it open with the token as the seeded query. One fetch
  // effect (below) runs for whichever gesture is live.
  const [menuOpen, setMenuOpen] = useState(false);
  const [seedQuery, setSeedQuery] = useState("");
  const [plusQuery, setPlusQuery] = useState("");
  useEffect(() => {
    if (!mentionOpen) return;
    // Deferred a frame — synchronous setState in an effect body is what the
    // react-hooks rule bans, and a menu opening one frame late is not
    // perceptible.
    const frame = requestAnimationFrame(() => {
      setMenuOpen(true);
      setSeedQuery(mentionQuery);
    });
    return () => cancelAnimationFrame(frame);
  }, [mentionOpen, mentionQuery]);
  useEffect(() => {
    if (!menuOpen) return;
    const query = plusQuery;
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
  }, [menuOpen, plusQuery]);

  function insertReference(markdown: string) {
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${markdown} ` : `${markdown} `));
  }

  // One pick handler for both gestures: a chip kind adds a chip (the draft
  // keeps the typed words), a reference kind becomes a link — replacing the
  // live @ token when the pick came from that gesture.
  function handleRecordPick(record: RecordReference) {
    if (record.kind === "person" || record.kind === "company" || record.kind === "zettel") {
      pickChip({ id: record.id, kind: record.kind, title: record.title, href: record.href });
      return;
    }
    if (mention) {
      setDraft((current) => replaceMention(current, mention, referenceLink(record)));
      return;
    }
    insertReference(referenceLink(record));
  }
  // Set by a send: the owner's own message always scrolls into view, even when
  // they had scrolled up to reread something.
  const forceScrollRef = useRef(false);
  const chat = useChatStream(runId, { onCitation, ...(initial?.length ? { initial: { blocks: initial } } : {}) });
  // A reconnect pause keeps the run's blocks streaming — a pause, not a loss.
  const busy =
    chat.connection === "connecting" || chat.connection === "streaming" || chat.connection === "reconnecting";
  /*
   * The stage chip: the run's own stage facts first (the same failed report
   * the Supervision panel classifies), the transport state only as the live
   * fallback — a failed run reads the panel's word for failed even while its
   * stream is reconnecting.
   */
  const stageStatus = stageChipStatus({
    connection: chat.connection,
    runFailed: chat.runFailed,
    lastFailedTurn: chat.lastFailedTurn,
  });
  const stageLabel = stageChipLabel(stageStatus);
  // The transcript renders the conversation: questions, answers, and the
  // model's rationale as its own collapsed pill. `transcript` (user/assistant
  // only) still drives optimistic-match, scroll, and pending-message logic.
  // Mention context is stripped before matching and rendering: the JSON the
  // model reads is appended after the typed words, and never belongs on screen.
  const transcript = chat.blocks
    .filter((block) => block.kind === "user" || block.kind === "assistant")
    .map((block) =>
      block.kind === "user" && hasMentionContext(block.text)
        ? { ...block, text: stripMentionContext(block.text) }
        : block,
    );
  /*
   * The message the owner just sent but the stream has not echoed. Shown until
   * the server's own copy arrives, matched on text so the two never both render:
   * a duplicate question reads as a double send.
   */
  const optimistic =
    carried && !transcript.some((block) => block.kind === "user" && block.text === carried) ? carried : null;
  const userTexts = transcript.filter((block) => block.kind === "user").map((block) => block.text);
  const waiting = stillPending(pending, userTexts);
  const lastAssistantIndex = transcript.map((b) => b.kind).lastIndexOf("assistant");

  const lastText = transcript[lastAssistantIndex]?.text;

  // The strip renders the passages the answer actually cites; the uncited
  // candidates stay in the tool pill.
  const cited = new Set(citedIndices(lastText ?? "", chat.citations));
  const shownCitations = chat.citations.filter((_, index) => cited.has(index));

  // Keep the newest text in view as it streams, without fighting a reader who
  // has scrolled up: only follow when already near the bottom.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom || forceScrollRef.current) node.scrollTop = node.scrollHeight;
    forceScrollRef.current = false;
  }, [transcript.length, lastText, waiting.length]);

  async function fetchChipContext(id: string, kind: MentionEntity["kind"]) {
    try {
      const context = await fetchMentionContext({ kind, id });
      setChips((current) =>
        current.map((chip) =>
          chip.entity.id === id
            ? context
              ? { ...chip, context, error: null }
              : { ...chip, error: "Could not load context. Retry." }
            : chip,
        ),
      );
    } catch {
      setChips((current) =>
        current.map((chip) => (chip.entity.id === id ? { ...chip, error: "Could not load context. Retry." } : chip)),
      );
    }
  }

  function pickChip(entity: MentionEntity) {
    setChips((current) => {
      if (current.some((chip) => chip.entity.id === entity.id)) return current;
      return [...current, { entity, context: null, error: null }];
    });
    void fetchChipContext(entity.id, entity.kind);
  }

  function retryChip(id: string) {
    const chip = chips.find((item) => item.entity.id === id);
    if (!chip) return;
    setChips((current) =>
      current.map((item) => (item.entity.id === id ? { ...item, context: null, error: null } : item)),
    );
    void fetchChipContext(id, chip.entity.kind);
  }

  function removeChip(id: string) {
    setChips((current) => current.filter((chip) => chip.entity.id !== id));
  }

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
        // Chips already fetched their context on pick; sending serializes
        // what is here and touches no network for it.
        const { payload } = serializeChips(chips);
        const result = await onContinue(runId, `${message}${payload}`);
        if (!result.ok) {
          restore(result.message);
          return;
        }
        setChips([]);
        if (result.runId !== runId) {
          // A new segment answered, so this transcript is no longer the head of
          // the conversation; the shell re-renders on the new run.
          router.refresh();
        }
        return;
      }
      const { payload } = serializeChips(chips);
      const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `${message}${payload}` }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string; title?: string } | null;
        restore(problem?.detail ?? problem?.title ?? "The message was not sent.");
        return;
      }
      setChips([]);
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
    setAttachNote(`Capturing ${file.name}…`);
    void uploadCaptureFile(file).then((result) => {
      setAttachNote(result.ok ? `Captured ${file.name} to your inbox.` : result.message);
    });
  }

  // A pasted screenshot is a capture too: the paste never becomes text or an
  // alt-text blob in the draft, it uploads through the same sniffed file route.
  function pasteCapture(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = eventFile(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    attachFile(file);
  }

  return (
    <section
      className={`flex min-h-0 flex-1 flex-col overflow-hidden ${className ?? ""}`}
      aria-label={title ?? `Chat about this ${subject.type}`}
    >
      {showHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-body-dense font-medium">{title ?? `This ${subject.type}`}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-data text-muted-foreground">
            {stageLabel ? <span>{stageLabel}</span> : null}
          </div>
        </header>
      ) : null}

      {/*
       * A page that hides the header still owes the reader the run's stage,
       * so it moves to a single quiet line above the transcript rather than
       * vanishing with the chrome it used to share. The waiting state stays
       * header-only: a conversation idle for its next message is not worth a
       * line of chrome on the headerless surfaces.
       */}
      {!showHeader && stageLabel && stageStatus !== "waiting" ? (
        <p className="text-muted-foreground pt-1 pb-2 text-data" role="status">
          {stageLabel}
        </p>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4">
        <ChatTranscript
          agent={agent}
          blocks={chat.blocks}
          tools={chat.tools}
          citations={chat.citations}
          shownCitations={shownCitations}
          runId={runId}
          transcriptEmpty={transcript.length === 0}
          optimistic={optimistic}
          waiting={waiting}
          busy={busy}
          emptyText={emptyText}
          subjectType={subject.type}
          error={chat.error}
          runFailed={chat.runFailed}
          connection={chat.connection}
          retryable={chat.retryable}
          onRetry={chat.retry}
          onRunFailedRetry={onRunFailedRetry}
          onRefineDiagram={refineDiagram}
        />
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
        <p className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-body-dense text-muted-foreground">
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
            <p role="alert" className="border-b border-border px-3.5 pt-2.5 pb-2 text-label text-destructive">
              {sendError}
            </p>
          )}
          <div className="px-3.5 pt-2.5">
            <ContextChips
              chips={chips}
              onRemove={removeChip}
              onRetry={retryChip}
              truncated={serializeChips(chips).truncated}
            />
          </div>
          <Textarea
            ref={composerRef}
            aria-label={composerLabel}
            className="composer-input max-h-48 min-h-[76px] resize-none rounded-none border-0 bg-transparent px-3.5 pt-3 pb-11 text-body leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
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
            onPaste={pasteCapture}
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
                open={menuOpen}
                initialQuery={seedQuery}
                onReference={handleRecordPick}
                onQueryChange={setPlusQuery}
                onOpenChange={(open) => {
                  setMenuOpen(open);
                  if (!open) setPlusQuery("");
                }}
                onFile={attachFile}
              />
              <span className="px-1 truncate text-data text-muted-foreground">{attachNote}</span>
            </div>
            <Button
              type="submit"
              size="icon"
              aria-label={sending ? "Sending" : "Send"}
              title={sending ? "Sending" : "Send"}
              className="size-8 shrink-0 rounded-full"
              disabled={
                !draft.trim() ||
                sending ||
                // A chip still loading or sitting on a failed fetch has no
                // context to serialize: sending would drop it silently. The
                // retry is one click; the removal is another.
                chips.some((chip) => chip.error !== null || chip.context === null)
              }
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/*
 * The action toolbar under a finished assistant message lives in
 * message-actions.tsx: it grows in the message-actions work, and this file
 * must not.
 */

/**
 * The model's visible rationale, collapsed the same way tool activity is: a
 * quiet pill that names it, body kept out of the way until asked for.
 */
export function ThinkingPill({ text, done }: { text: string; done: boolean }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full px-2 py-1 text-label text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 transition-transform group-open:rotate-0" />
        {done ? "Thought process" : "Thinking\u2026"}
      </summary>
      <p className="text-muted-foreground mt-1 whitespace-pre-wrap border-l border-border pl-3 text-body-dense leading-6">
        {text}
      </p>
    </details>
  );
}
