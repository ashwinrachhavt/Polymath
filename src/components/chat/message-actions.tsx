"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, FileText, Lightbulb, MessageSquare, Sparkles } from "lucide-react";
import { MessageComments } from "./message-comments";
import { MessageFeedback } from "./message-feedback";
import { saveMessageAsIdeaAction, saveMessageAsNoteAction } from "@/app/(workspace)/polymath/[runId]/message-actions";
import { zettelizeThreadAction } from "@/app/(workspace)/polymath/[runId]/zettel-actions";

const quietButton =
  "text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

type ExtractScope = "message" | "last5" | "thread";

const EXTRACT_SCOPES: Array<{ scope: ExtractScope; label: string }> = [
  { scope: "message", label: "This message" },
  { scope: "last5", label: "The last 5 messages" },
  { scope: "thread", label: "The whole conversation" },
];

/*
 * The action toolbar under a finished assistant message: copy, comment, save
 * as note, save as idea, extract ideas, then like and dislike. Icons rest at
 * a quiet muted tone and come forward on hover, so the actions stay
 * discoverable and keyboard-visible (a hover-only reveal would hide them from
 * axe and from keyboard users) without shouting in the transcript. A save or
 * extraction that fails reports its error on one line under the toolbar —
 * never a silent no-op.
 */
export function MessageActions({
  runId,
  turnId,
  text,
  messageId,
}: {
  runId: string;
  turnId: string;
  text: string;
  /** Stored message to address; absent blocks cannot take comments. */
  messageId?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [saving, setSaving] = useState<"note" | "idea" | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [extracting, setExtracting] = useState<ExtractScope | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where a successful extraction's review happens — the Ideas "In review"
  // queue, which lists chat-sourced proposals the workbench cannot show.
  const [reviewHref, setReviewHref] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A blocked clipboard is not an error the transcript should carry.
    }
  }

  async function save(kind: "note" | "idea") {
    setSaving(kind);
    setError(null);
    // A fresh key per attempt: a retry after a failure is a new save.
    const input = { runId, text, idempotencyKey: crypto.randomUUID() };
    const result = kind === "note" ? await saveMessageAsNoteAction(input) : await saveMessageAsIdeaAction(input);
    setSaving(null);
    if (!result.ok) setError(result.error);
  }

  async function extract(scope: ExtractScope) {
    setExtracting(scope);
    setError(null);
    setNotice(null);
    setReviewHref(null);
    const result = await zettelizeThreadAction({
      runId,
      scope,
      ...(scope === "message" ? { messageId: messageId ?? undefined } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    setExtracting(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const unread = result.unreadChars > 0 ? ` ${result.unreadChars.toLocaleString()} characters were not read.` : "";
    setNotice(
      result.created === 0
        ? `No new ideas.${unread}`
        : `${result.created} idea${result.created === 1 ? "" : "s"} created.${unread}`,
    );
    setReviewHref(result.created > 0 ? "/polymath/ideas" : null);
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => void copy()}
          className={quietButton}
        >
          {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
        </button>
        {messageId ? (
          <button
            type="button"
            aria-label={showComments ? "Hide comments" : "Comment"}
            title={showComments ? "Hide comments" : "Comment"}
            aria-expanded={showComments}
            onClick={() => setShowComments((v) => !v)}
            className={quietButton}
          >
            <MessageSquare aria-hidden className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={saving === "note" ? "Saving…" : "Save as note"}
          title={saving === "note" ? "Saving…" : "Save as note"}
          disabled={saving !== null}
          onClick={() => void save("note")}
          className={quietButton}
        >
          <FileText aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={saving === "idea" ? "Saving…" : "Save as idea"}
          title={saving === "idea" ? "Saving…" : "Save as idea"}
          disabled={saving !== null}
          onClick={() => void save("idea")}
          className={quietButton}
        >
          <Lightbulb aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={extracting ? "Extracting…" : "Extract ideas"}
          title={extracting ? "Extracting…" : "Extract ideas"}
          aria-expanded={extractOpen}
          disabled={extracting !== null || saving !== null}
          onClick={() => setExtractOpen((v) => !v)}
          className={quietButton}
        >
          <Sparkles aria-hidden className="size-3.5" />
        </button>
        <MessageFeedback runId={runId} turnId={turnId} initial={null} />
      </div>
      {extractOpen && !extracting ? (
        <div role="menu" aria-label="Extract ideas from" className="border-border mt-1 w-fit rounded-md border p-1">
          {EXTRACT_SCOPES.filter((option) => option.scope !== "message" || messageId).map((option) => (
            <button
              key={option.scope}
              type="button"
              role="menuitem"
              className="hover:bg-muted focus-visible:ring-ring block w-full rounded px-2 py-1 text-left text-xs outline-none focus-visible:ring-2"
              onClick={() => void extract(option.scope)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {extracting ? (
        <p role="status" className="text-muted-foreground mt-0.5 text-xs">
          Reading the conversation…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive mt-0.5 text-xs">
          {error}
        </p>
      ) : !error && notice ? (
        <p role="status" className="text-muted-foreground mt-0.5 text-xs">
          {notice}{" "}
          {reviewHref ? (
            <Link href={reviewHref} className="text-foreground font-medium underline underline-offset-4">
              See in Ideas
            </Link>
          ) : null}
        </p>
      ) : null}
      {messageId && showComments ? <MessageComments messageId={messageId} initialComments={[]} /> : null}
    </div>
  );
}
