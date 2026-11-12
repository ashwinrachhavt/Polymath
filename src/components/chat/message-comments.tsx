"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/time";
import {
  addMessageCommentAction,
  resolveMessageCommentAction,
  type PanelComment,
} from "@/app/(workspace)/polymath/[runId]/comment-actions";
import { randomId } from "@/lib/random-id";

/*
 * The inline panel for one message's comments (plan Task 9). Comments belong
 * to the message as a whole: no text-anchor ranges, no replies — the same
 * ceiling the note comments chose. With no comments yet the panel is just
 * the composer, so the toolbar toggle always has something to open.
 */

function CommentRow({ comment }: { comment: PanelComment }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Local mirror of resolvedAt: router.refresh() re-renders the server tree
  // but does not remount this row, so without it the panel would keep
  // showing the old state and the next click would send the same toggle.
  const [resolvedOverride, setResolvedOverride] = useState<boolean | null>(null);
  const resolved = resolvedOverride ?? comment.resolvedAt !== null;
  const toggle = async () => {
    setBusy(true);
    const next = !resolved;
    const result = await resolveMessageCommentAction({
      commentId: comment.id,
      resolved: next,
      idempotencyKey: randomId(),
    });
    setBusy(false);
    if (!result.ok) return;
    setResolvedOverride(result.resolvedAt !== null);
    router.refresh();
  };
  return (
    <li className={`rounded-md border px-3 py-2.5 ${resolved ? "border-transparent bg-muted/30" : "border-border"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-body-dense font-medium ${resolved ? "text-muted-foreground" : ""}`}>
          {comment.authorName ?? "You"}
        </span>
        <time className="text-data text-muted-foreground" dateTime={comment.createdAt}>
          {timeAgo(comment.createdAt)}
        </time>
      </div>
      <p
        className={`mt-1 whitespace-pre-wrap text-body-dense leading-6 ${resolved ? "text-muted-foreground line-through decoration-border" : ""}`}
      >
        {comment.body}
      </p>
      <div className="mt-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={busy}
          onClick={toggle}
        >
          {resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
    </li>
  );
}

export function MessageComments({
  messageId,
  initialComments,
}: {
  messageId: string;
  initialComments: PanelComment[];
}) {
  const router = useRouter();
  const [comments, setComments] = useState(initialComments);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const body = draft.trim();
    if (!body || pending) return;
    setPending(true);
    setError("");
    const result = await addMessageCommentAction({ messageId, body, idempotencyKey: randomId() });
    setPending(false);
    if (!result.ok) return setError(result.error);
    // Only clear what was submitted: text typed while the request was in
    // flight belongs to the next comment.
    setDraft((current) => (current === body ? "" : current));
    setComments((current) => [...current, result.comment]);
    router.refresh();
  };

  return (
    <section
      aria-label="Comments on this message"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 bg-muted/20 p-3"
    >
      {comments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label="Add a comment"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Add a comment…"
          maxLength={2000}
          rows={2}
          className="rounded-md border border-border bg-background px-3 py-2 text-body-dense leading-6 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="xs" disabled={pending || !draft.trim()}>
            {pending ? "Adding…" : "Comment"}
          </Button>
          {error && (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
