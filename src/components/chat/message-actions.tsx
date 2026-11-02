"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { MessageFeedback } from "./message-feedback";

/*
 * The action toolbar under a finished assistant message: copy, then like and
 * dislike. Icons rest at a quiet muted tone and come forward on hover, so the
 * actions stay discoverable and keyboard-visible (a hover-only reveal would
 * hide them from axe and from keyboard users) without shouting in the
 * transcript.
 */
export function MessageActions({
  runId,
  turnId,
  text,
}: {
  runId: string;
  turnId: string;
  text: string;
  /** Stored message to address; rendered by the message-actions work. */
  messageId?: string | null;
  /** Opens the comment control; rendered by the message-actions work. */
  onComment?: () => void;
}) {
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
