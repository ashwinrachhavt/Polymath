import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { users } from "@/domains/identity/tables";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { messageComments, messages, threads } from "./schema";

/*
 * Margin comments on a chat message (plan Task 7). The same whole-message
 * ceiling as note comments: no text-anchor ranges, no replies. Resolving
 * hides a comment from the open count but never deletes it; un-resolving
 * brings it back. Deleting the thread deletes its comments by cascade - the
 * conversation, not the comment, is the unit of retention.
 *
 * ASH-306: a Supervisor thread (subjectType "supervisor", subjectId = the
 * owner's user id) is the owner's private exchange. Reads and writes both
 * gate on the same visibility predicate the conversations list uses, so a
 * fellow member's refused access is indistinguishable from a wrong message
 * id.
 *
 * Every command is one transaction: receipt -> ownership check -> change ->
 * audit, per the notes-core rule that a change with no audit row did not
 * happen. Comments never touch the thread or its messages.
 */

export class MessageCommentError extends Error {
  readonly code = "message_comment_invalid";
  constructor(message: string) {
    super(message);
    this.name = "MessageCommentError";
  }
}

type Keyed = { idempotencyKey?: string };

/** ASH-306: the thread this message lives on must be visible to this caller. */
function supervisorThreadVisibleTo(auth: AuthContext) {
  return or(isNull(threads.subjectType), ne(threads.subjectType, "supervisor"), eq(threads.subjectId, auth.userId));
}

/** The comment rows the panel renders, oldest first like a margin thread. */
export type MessageCommentItem = {
  id: string;
  body: string;
  resolvedAt: Date | null;
  createdAt: Date;
  /** The author's display name; null when their account has none. */
  authorName: string | null;
};

export const messageCommentBody = z
  .string()
  .max(2000)
  .transform((body) => body.trim())
  .refine((body) => body.length >= 1, "Write a comment first.");

/** The message's live comments with the author's display name, oldest first. */
export async function listMessageComments(auth: AuthContext, messageId: string): Promise<MessageCommentItem[]> {
  return withTransaction(async (tx) => {
    const [owned] = await tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(
        and(eq(messages.id, messageId), eq(messages.workspaceId, auth.workspaceId), supervisorThreadVisibleTo(auth)),
      )
      .limit(1);
    if (!owned) throw new MessageCommentError("That message does not exist in this workspace.");
    return tx
      .select({
        id: messageComments.id,
        body: messageComments.body,
        resolvedAt: messageComments.resolvedAt,
        createdAt: messageComments.createdAt,
        authorName: users.displayName,
      })
      .from(messageComments)
      .leftJoin(users, eq(users.id, messageComments.createdBy))
      .where(
        and(
          eq(messageComments.workspaceId, auth.workspaceId),
          eq(messageComments.messageId, messageId),
          isNull(messageComments.archivedAt),
        ),
      )
      .orderBy(asc(messageComments.createdAt));
  });
}

export async function addMessageComment(
  auth: AuthContext,
  input: Keyed & { messageId: string; body: string },
): Promise<MessageCommentItem> {
  return withTransaction(async (tx) => {
    const receipt = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "addMessageComment", ...input },
      async () => {
        const [message] = await tx
          .select({ id: messages.id, threadId: messages.threadId })
          .from(messages)
          .innerJoin(threads, eq(threads.id, messages.threadId))
          .where(
            and(
              eq(messages.id, input.messageId),
              eq(messages.workspaceId, auth.workspaceId),
              supervisorThreadVisibleTo(auth),
            ),
          )
          .limit(1);
        if (!message) throw new MessageCommentError("That message does not exist in this workspace.");
        // Parse, then map a schema failure onto the domain error the action
        // layer renders; a raw ZodError escaping is a 500.
        const parsed = messageCommentBody.safeParse(input.body);
        if (!parsed.success)
          throw new MessageCommentError(parsed.error.issues[0]?.message ?? "That comment is not valid.");
        const body = parsed.data;
        const [comment] = await tx
          .insert(messageComments)
          .values({
            workspaceId: auth.workspaceId,
            threadId: message.threadId,
            messageId: message.id,
            body,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning({
            id: messageComments.id,
            body: messageComments.body,
            resolvedAt: messageComments.resolvedAt,
            createdAt: messageComments.createdAt,
          });
        if (!comment) throw new MessageCommentError("The comment could not be saved.");
        // RETURNING cannot join, so the author's name is read for the panel's
        // first paint instead of left null.
        const [author] = await tx
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, auth.userId))
          .limit(1);
        await recordAudit(
          auth,
          {
            action: "message.comment_added",
            subjectType: "message",
            subjectId: message.id,
            summary: "Commented on a message",
            metadata: { commentId: comment.id },
          },
          tx,
        );
        return { ...comment, authorName: author?.displayName ?? null };
      },
    );
    const { value } = receipt;
    return {
      ...value,
      // A replayed receipt comes back from a JSONB column, so Date fields
      // arrive as strings; revive them or the action's .toISOString() throws.
      resolvedAt: value.resolvedAt ? new Date(value.resolvedAt) : null,
      createdAt: new Date(value.createdAt),
    };
  });
}

export async function resolveMessageComment(
  auth: AuthContext,
  input: Keyed & { commentId: string; resolved: boolean },
): Promise<{ id: string; resolvedAt: Date | null }> {
  return withTransaction(async (tx) => {
    const receipt = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "resolveMessageComment", ...input },
      async () => {
        // Ownership joins the comment to this workspace's messages, and the
        // message to a thread visible to this caller, so a cross-workspace or
        // supervisor-private commentId is indistinguishable from a wrong one.
        const [row] = await tx
          .select({
            id: messageComments.id,
            resolvedAt: messageComments.resolvedAt,
            messageId: messageComments.messageId,
          })
          .from(messageComments)
          .innerJoin(messages, eq(messages.id, messageComments.messageId))
          .innerJoin(threads, eq(threads.id, messages.threadId))
          .where(
            and(
              eq(messageComments.id, input.commentId),
              eq(messageComments.workspaceId, auth.workspaceId),
              supervisorThreadVisibleTo(auth),
            ),
          )
          .limit(1);
        if (!row) throw new MessageCommentError("That comment does not exist in this workspace.");
        const resolvedAt = input.resolved ? new Date() : null;
        await tx
          .update(messageComments)
          .set({ resolvedAt, updatedAt: new Date(), updatedBy: auth.userId, version: messageComments.version })
          .where(eq(messageComments.id, row.id));
        await recordAudit(
          auth,
          {
            action: input.resolved ? "message.comment_resolved" : "message.comment_reopened",
            subjectType: "message",
            // The audit subject is the message the comment lives on; the
            // comment id rides in metadata where day pages can still find it.
            subjectId: row.messageId,
            summary: input.resolved ? "Resolved a message comment" : "Reopened a message comment",
            metadata: { commentId: row.id },
          },
          tx,
        );
        return { id: row.id, resolvedAt };
      },
    );
    const { value } = receipt;
    return {
      ...value,
      // Same JSONB-replay revival as addMessageComment.
      resolvedAt: value.resolvedAt ? new Date(value.resolvedAt) : null,
    };
  });
}
