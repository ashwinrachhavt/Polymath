"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/time";
import { addNoteCommentAction, resolveNoteCommentAction } from "./actions";

/*
 * The margin panel for a note's comments (Notion-feel, owner direction
 * 2026-10-28). Comments belong to the note as a whole: no text-anchor
 * ranges, no replies. That ceiling is deliberate - anchors need span storage
 * and a drift rule the smallest honest version does not carry.
 */

export type PanelComment = {
  id: string;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  authorName: string | null;
};

function CommentRow({ comment }: { comment: PanelComment }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const resolved = comment.resolvedAt !== null;
  const toggle = async () => {
    setBusy(true);
    const result = await resolveNoteCommentAction({ commentId: comment.id, resolved: !resolved, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (result.ok) router.refresh();
  };
  return (
    <li className={`rounded-md border px-3 py-2.5 ${resolved ? "border-transparent bg-muted/30" : "border-border"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[13px] font-medium ${resolved ? "text-muted-foreground" : ""}`}>{comment.authorName ?? "You"}</span>
        <time className="text-[11px] text-muted-foreground" dateTime={comment.createdAt}>
          {timeAgo(comment.createdAt)}
        </time>
      </div>
      <p className={`mt-1 whitespace-pre-wrap text-[13px] leading-6 ${resolved ? "text-muted-foreground line-through decoration-border" : ""}`}>{comment.body}</p>
      <div className="mt-1.5">
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" disabled={busy} onClick={toggle}>
          {resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
    </li>
  );
}

export function NoteCommentsPanel({ noteId, initialComments }: { noteId: string; initialComments: PanelComment[] }) {
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
    const result = await addNoteCommentAction({ noteId, body, idempotencyKey: crypto.randomUUID() });
    setPending(false);
    if (!result.ok) return setError(result.error);
    setDraft("");
    setComments((current) => [...current, result.comment]);
    router.refresh();
  };

  const openCount = comments.filter((c) => c.resolvedAt === null).length;

  return (
    <section aria-label="Comments" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-xs font-medium text-muted-foreground">
        Comments <span className="tabular-nums">{openCount}</span>
      </h2>
      {comments.length === 0 ? (
        <p className="text-[13px] leading-6 text-muted-foreground/80">Nothing here yet. Write what this note still owes you.</p>
      ) : (
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
          rows={3}
          className="rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
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

/** The header-zone marker shown only when the note has open comments. */
export function CommentsBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Check aria-hidden className="size-3" />
      <span className="tabular-nums">{count}</span>
    </span>
  );
}
