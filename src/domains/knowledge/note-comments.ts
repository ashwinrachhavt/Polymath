import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { users } from "@/domains/identity/tables";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { artifacts, noteComments } from "./schema";

/*
 * Margin comments on a note (Notion-feel, owner direction 2026-10-28). The
 * smallest honest version: whole-note comments only - no text-anchor ranges,
 * no replies. That ceiling is deliberate; anchors would bind a comment to
 * spans of the markdown body, which needs span storage and a drift rule of
 * its own. Resolving hides a comment from the open count but never deletes
 * it; un-resolving brings it back.
 *
 * Every command is one transaction: receipt -> ownership check -> change ->
 * audit, per the notes-core rule that a change with no audit row did not
 * happen. Comments never touch the artifact's version: a comment is margin
 * talk, not a content edit, so it cannot race the editor's CAS guard.
 */

export class NoteCommentError extends Error {
  readonly code = "note_comment_invalid";
  constructor(message: string) {
    super(message);
    this.name = "NoteCommentError";
  }
}

type Keyed = { idempotencyKey?: string };

/** The comment rows the panel renders, oldest first like a margin thread. */
export type NoteCommentItem = {
  id: string;
  body: string;
  resolvedAt: Date | null;
  createdAt: Date;
  /** The author's display name; null when their account has none. */
  authorName: string | null;
};

export const noteCommentBody = z
  .string()
  .max(2000)
  .transform((body) => body.trim())
  .refine((body) => body.length >= 1, "Write a comment first.");

/** The note's live comments with the author's display name, oldest first. */
export async function listNoteComments(auth: AuthContext, noteId: string): Promise<NoteCommentItem[]> {
  return withTransaction(async (tx) => {
    const [owned] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.id, noteId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")))
      .limit(1);
    if (!owned) throw new NoteCommentError("That note does not exist in this workspace.");
    return tx
      .select({
        id: noteComments.id,
        body: noteComments.body,
        resolvedAt: noteComments.resolvedAt,
        createdAt: noteComments.createdAt,
        authorName: users.displayName,
      })
      .from(noteComments)
      .leftJoin(users, eq(users.id, noteComments.createdBy))
      .where(and(eq(noteComments.workspaceId, auth.workspaceId), eq(noteComments.noteId, noteId), isNull(noteComments.archivedAt)))
      .orderBy(asc(noteComments.createdAt));
  });
}

export async function addNoteComment(
  auth: AuthContext,
  input: Keyed & { noteId: string; body: string },
): Promise<NoteCommentItem> {
  return withTransaction(async (tx) => {
    return (await withReceipt(tx, auth, input.idempotencyKey, { op: "addNoteComment", ...input }, async () => {
      const [note] = await tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, input.noteId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")))
        .limit(1);
      if (!note) throw new NoteCommentError("That note does not exist in this workspace.");
      // Parse, then map a schema failure onto the domain error the action
      // layer renders; a raw ZodError escaping is a 500.
      const parsed = noteCommentBody.safeParse(input.body);
      if (!parsed.success) throw new NoteCommentError(parsed.error.issues[0]?.message ?? "That comment is not valid.");
      const body = parsed.data;
      const [comment] = await tx
        .insert(noteComments)
        .values({ workspaceId: auth.workspaceId, noteId: note.id, body, createdBy: auth.userId, updatedBy: auth.userId })
        .returning({
          id: noteComments.id,
          body: noteComments.body,
          resolvedAt: noteComments.resolvedAt,
          createdAt: noteComments.createdAt,
        });
      if (!comment) throw new NoteCommentError("The comment could not be saved.");
      // RETURNING cannot join, so the author's name is read for the panel's
      // first paint instead of left null.
      const [author] = await tx
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1);
      await recordAudit(
        auth,
        { action: "note.comment_added", subjectType: "artifact", subjectId: note.id, summary: "Commented on a note", metadata: { commentId: comment.id } },
        tx,
      );
      return { ...comment, authorName: author?.displayName ?? null };
    })).value;
  });
}

export async function resolveNoteComment(
  auth: AuthContext,
  input: Keyed & { commentId: string; resolved: boolean },
): Promise<{ id: string; resolvedAt: Date | null }> {
  return withTransaction(async (tx) => {
    return (await withReceipt(tx, auth, input.idempotencyKey, { op: "resolveNoteComment", ...input }, async () => {
      // Ownership joins the comment to this workspace's notes, so a
      // cross-workspace commentId is indistinguishable from a wrong one.
      const [row] = await tx
        .select({ id: noteComments.id, resolvedAt: noteComments.resolvedAt })
        .from(noteComments)
        .innerJoin(artifacts, eq(artifacts.id, noteComments.noteId))
        .where(and(eq(noteComments.id, input.commentId), eq(noteComments.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")))
        .limit(1);
      if (!row) throw new NoteCommentError("That comment does not exist in this workspace.");
      const resolvedAt = input.resolved ? new Date() : null;
      await tx
        .update(noteComments)
        .set({ resolvedAt, updatedAt: new Date(), updatedBy: auth.userId, version: noteComments.version })
        .where(eq(noteComments.id, row.id));
      await recordAudit(
        auth,
        {
          action: input.resolved ? "note.comment_resolved" : "note.comment_reopened",
          subjectType: "artifact",
          subjectId: input.commentId,
          summary: input.resolved ? "Resolved a note comment" : "Reopened a note comment",
          metadata: {},
        },
        tx,
      );
      return { id: row.id, resolvedAt };
    })).value;
  });
}
