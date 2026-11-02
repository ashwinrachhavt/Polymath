"use client";

import { useState } from "react";
import { Check, Copy, FileText, Lightbulb, MessageSquare } from "lucide-react";
import { MessageComments } from "./message-comments";
import { MessageFeedback } from "./message-feedback";
import { saveMessageAsIdeaAction, saveMessageAsNoteAction } from "@/app/(workspace)/polymath/[runId]/message-actions";

const quietButton =
  "text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/*
 * The action toolbar under a finished assistant message: copy, comment, save
 * as note, save as idea, then like and dislike. Icons rest at a quiet muted
 * tone and come forward on hover, so the actions stay discoverable and
 * keyboard-visible (a hover-only reveal would hide them from axe and from
 * keyboard users) without shouting in the transcript. A save that fails
 * reports its error on one line under the toolbar — never a silent no-op.
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
  const [error, setError] = useState<string | null>(null);

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
        <MessageFeedback runId={runId} turnId={turnId} initial={null} />
      </div>
      {error ? (
        <p role="alert" className="text-destructive mt-0.5 text-xs">
          {error}
        </p>
      ) : null}
      {messageId && showComments ? <MessageComments messageId={messageId} initialComments={[]} /> : null}
    </div>
  );
}
