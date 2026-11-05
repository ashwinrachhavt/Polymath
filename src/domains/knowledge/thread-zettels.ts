import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { messages, threads } from "@/domains/agents/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { withReceipt } from "@/domains/audit/receipt";
import { commitNoteSnapshot, createNoteInTx } from "./notes";
import { ThreadEmptyError, ThreadNotFoundError, transcriptMarkdown } from "./thread-graph";
import { createZettelsFromSource } from "./zettels";
import { artifactLinks, artifactVersions, artifacts } from "./schema";

/*
 * Zettelizing a conversation (plan Task 20): the thread's messages become one
 * note-kind artifact through the same source edge syncThreadToGraph uses, and
 * the direct-creation pass reads it. Note-kind, not "transcript": a
 * thread-sourced idea's provenance card must not read as a recording, and the
 * two thread-to-artifact paths stay consistent, differing only in which
 * messages are in the body. A second pass over an unchanged thread reuses
 * that artifact and creates nothing new: its candidates are deduped against
 * the thread's own earlier proposals and cards for the artifact by
 * claim/quote overlap — the span-key index alone misses a re-chunked region —
 * and the near-duplicate gate flags whatever survives.
 */

export type ZettelizeThreadResult = { artifactId: string; created: number; unreadChars: number };

/** The newest `count` conversation messages, oldest first — what "the last 5" means. */
export async function listLastMessageIds(auth: AuthContext, threadId: string, count: number): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.workspaceId, auth.workspaceId),
        inArray(messages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(count);
  return rows.reverse().map((row) => row.id);
}

type ThreadArtifactBody =
  | { mode: "created" | "reused"; artifactId: string; text: string }
  | { mode: "stale"; artifactId: string; text: string; expectedVersion: number };

export async function zettelizeThread(
  auth: AuthContext,
  input: { threadId: string; messageIds?: string[]; idempotencyKey: string },
): Promise<ZettelizeThreadResult> {
  const { value: body } = await withTransaction((tx) =>
    withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { op: "zettelizeThread", threadId: input.threadId, messageIds: input.messageIds ?? null },
      () => upsertThreadArtifact(auth, input, tx),
    ),
  );
  // A changed conversation is a new version of the same artifact, written by
  // the same keyed snapshot flow a note edit uses — outside this receipt's
  // transaction, which has already committed.
  if (body.mode === "stale") {
    await commitNoteSnapshot(auth, {
      idempotencyKey: randomUUID(),
      artifactId: body.artifactId,
      expectedVersion: body.expectedVersion,
      content: { format: "markdown", text: body.text },
      plainText: body.text,
      note: "Conversation updated",
    });
  }
  const result = await createZettelsFromSource(auth, { sourceArtifactId: body.artifactId });
  return { artifactId: body.artifactId, created: result.created.length, unreadChars: result.unreadChars };
}

async function upsertThreadArtifact(
  auth: AuthContext,
  input: { threadId: string; messageIds?: string[] },
  tx: TxDrizzle,
): Promise<ThreadArtifactBody> {
  const [thread] = await tx
    .select({ id: threads.id, title: threads.title, subjectType: threads.subjectType, subjectId: threads.subjectId })
    .from(threads)
    .where(and(eq(threads.id, input.threadId), eq(threads.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!thread) throw new ThreadNotFoundError();
  // ASH-306: a Supervisor thread is its owner's private exchange; mining it
  // into the shared knowledge graph is the owner's call alone.
  if (thread.subjectType === "supervisor" && thread.subjectId !== auth.userId) throw new ThreadNotFoundError();

  const rows = await tx
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      input.messageIds?.length
        ? and(
            eq(messages.threadId, thread.id),
            eq(messages.workspaceId, auth.workspaceId),
            inArray(messages.id, input.messageIds),
          )
        : and(eq(messages.threadId, thread.id), eq(messages.workspaceId, auth.workspaceId)),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const text = transcriptMarkdown(rows);
  if (!text) throw new ThreadEmptyError();
  const title = thread.title?.trim() || firstLine(text);

  const [existing] = await tx
    .select({ id: artifacts.id, version: artifacts.version, currentText: artifactVersions.plainText })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.targetType, "thread"),
        eq(artifactLinks.targetId, thread.id),
        eq(artifactLinks.linkType, "source"),
      ),
    )
    .limit(1);

  const content = { format: "markdown", text };
  if (existing) {
    // A pass over an unchanged thread writes nothing: no empty versions, no
    // re-extraction, no second set of proposals.
    if (existing.currentText === text) return { mode: "reused", artifactId: existing.id, text };
    return { mode: "stale", artifactId: existing.id, text, expectedVersion: existing.version };
  }
  const note = await createNoteInTx(tx, auth, { title, content, plainText: text, kind: "note" });
  await tx.insert(artifactLinks).values({
    workspaceId: auth.workspaceId,
    artifactId: note.id,
    targetType: "thread",
    targetId: thread.id,
    label: title,
    linkType: "source",
  });
  return { mode: "created", artifactId: note.id, text };
}

function firstLine(text: string): string {
  return (
    text
      .replace(/\*\*(You|Assistant):\*\*\s*/, "")
      .split("\n")[0]
      .slice(0, 80) || "Conversation"
  );
}
