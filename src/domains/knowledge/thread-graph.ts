import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "@/domains/identity/resolve";
import { messages, threads } from "@/domains/agents/schema";
import { db } from "@/lib/db";
import { embedArtifact } from "./embedding";
import { commitNoteSnapshot, createNoteInTx } from "./notes";
import { withTransaction } from "@/lib/db-transaction";
import { artifactLinks, artifactVersions, artifacts } from "./schema";
import type { OutboxHandler } from "@/domains/audit/outbox";
import { THREAD_CHANGED_TOPIC } from "./thread-sync-event";

/*
 * A human-agent conversation is a node in the knowledge graph as a whole. The
 * thread stays where the agent engine keeps it; the graph holds one
 * `transcript` artifact per thread, the same versioned, embeddable container
 * every other card lives in, with a `source` edge to the thread. That one
 * projection is all it takes for a conversation to be searched, embedded as a
 * unit, related to notes and zettels, linked with a typed relation and drawn on
 * the canvas. Syncing again writes a new version, never a second node.
 */

export class ThreadNotFoundError extends Error {
  constructor() {
    super("That conversation does not exist in this workspace.");
    this.name = "ThreadNotFoundError";
  }
}

/** The conversation as one readable document: who said what, in order. */
export class ThreadEmptyError extends Error {
  constructor() {
    super("This conversation has no messages to add yet.");
    this.name = "ThreadEmptyError";
  }
}

export function transcriptMarkdown(rows: { role: string; content: string | null }[]): string {
  return rows
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => `**${m.role === "user" ? "You" : "Assistant"}:** ${m.content!.trim()}`)
    .join("\n\n");
}

export async function syncThreadToGraph(auth: AuthContext, threadId: string): Promise<{ artifactId: string; created: boolean }> {
  const [thread] = await db
    .select({ id: threads.id, title: threads.title })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!thread) throw new ThreadNotFoundError();
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.workspaceId, auth.workspaceId)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const text = transcriptMarkdown(rows);
  if (!text) throw new ThreadEmptyError();
  const title = thread.title?.trim() || firstLine(text);

  const [existing] = await db
    .select({ id: artifacts.id, version: artifacts.version, currentText: artifactVersions.plainText })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(
      eq(artifactLinks.workspaceId, auth.workspaceId),
      eq(artifactLinks.targetType, "thread"),
      eq(artifactLinks.targetId, threadId),
      eq(artifactLinks.linkType, "source"),
    ))
    .limit(1);

  const content = { format: "markdown", text };
  if (existing) {
    // A sync with nothing new writes nothing: no empty versions, no re-embed.
    if (existing.currentText === text) return { artifactId: existing.id, created: false };
    await commitNoteSnapshot(auth, { idempotencyKey: randomUUID(), artifactId: existing.id, expectedVersion: existing.version, content, plainText: text, note: "Conversation updated" });
    return { artifactId: existing.id, created: false };
  }
  const created = await withTransaction(async (tx) => {
    const note = await createNoteInTx(tx, auth, { title, content, plainText: text, kind: "transcript" });
    await tx.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: note.id,
      targetType: "thread",
      targetId: threadId,
      label: title,
      linkType: "source",
    });
    return note;
  });
  try {
    await embedArtifact(auth, { artifactId: created.id });
  } catch (cause) {
    console.error(`embedArtifact for thread failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { artifactId: created.id, created: true };
}

function firstLine(text: string): string {
  return text.replace(/\*\*(You|Assistant):\*\*\s*/, "").split("\n")[0].slice(0, 80) || "Conversation";
}

/**
 * Outbox consumer: sync the thread the event names. A thread that was deleted
 * or has no text yet completes quietly; anything else throws so the
 * dispatcher retries. The owner lookup is passed in so this module does not
 * depend on the handler table.
 */
export function threadChangedHandler(ownerAuth: (workspaceId: string) => Promise<AuthContext | null>): OutboxHandler {
  return async (event) => {
    const threadId = (event.payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== "string") return;
    const auth = await ownerAuth(event.workspaceId);
    if (!auth) throw new Error("workspace has no active owner to act for the conversation sync");
    try {
      await syncThreadToGraph(auth, threadId);
    } catch (cause) {
      if (cause instanceof ThreadNotFoundError || cause instanceof ThreadEmptyError) return;
      throw cause;
    }
  };
}

export { THREAD_CHANGED_TOPIC };
