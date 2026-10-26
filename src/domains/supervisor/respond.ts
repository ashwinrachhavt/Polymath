/*
 * ASH-306: the Supervisor's deterministic half. A navigation message is
 * answered by the product, not the model: the exchange is written to the
 * owner's one persistent Supervisor thread (user message + assistant reply
 * carrying the surface card as a structured part) in one transaction, so the
 * timeline on any of the owner's devices shows exactly what they were shown
 * in place.
 *
 * Ownership (review-driven): the ticket says "a single persistent
 * conversation" and never asks for a thread shared across workspace members,
 * and a workspace-shared thread would leak one member's private assistant
 * exchanges to another. The thread is therefore per authenticated user
 * within the workspace: subjectType "supervisor" + subjectId = the owner's
 * user id. Retrieval enforces the same boundary (conversations/queries.ts);
 * the write path holds a per-owner advisory lock so two concurrent first
 * messages can never open two threads for the same owner.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ensureProfile } from "@/domains/agents/commands";
import { messages, threads } from "@/domains/agents/schema";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { buildSurfaceCard, SURFACE_CARD_PART, type SurfaceCard } from "./cards";
import { parseNavigationIntent, SURFACE_LABEL, type NavigationIntent } from "./navigation";

export const SUPERVISOR_SUBJECT = "supervisor";

type Db = TxDrizzle;

export async function getOrCreateSupervisorThread(auth: AuthContext, tx: Db): Promise<string> {
  const agentProfileId = await ensureProfile(auth.workspaceId);
  // Serialize first-message races per owner; the lock releases with the
  // transaction, so a crashed attempt never wedges the workspace.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supervisor-thread:${auth.workspaceId}:${auth.userId}`}, 0))`,
  );
  const [existing] = await tx
    .select({ id: threads.id })
    .from(threads)
    .where(and(
      eq(threads.workspaceId, auth.workspaceId),
      eq(threads.agentProfileId, agentProfileId),
      eq(threads.subjectType, SUPERVISOR_SUBJECT),
      eq(threads.subjectId, auth.userId),
      isNull(threads.archivedAt),
    ))
    .orderBy(desc(threads.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const [thread] = await tx
    .insert(threads)
    .values({
      workspaceId: auth.workspaceId,
      agentProfileId,
      title: "Assistant",
      subjectType: SUPERVISOR_SUBJECT,
      subjectId: auth.userId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning({ id: threads.id });
  return thread.id;
}

function replyText(intent: NavigationIntent, card: SurfaceCard): string {
  if (intent.kind === "open_note") {
    return card.items.length
      ? `Here ${card.items.length === 1 ? "it is" : "are the closest notes"}.`
      : card.emptyText ?? "Nothing matched.";
  }
  return card.items.length
    ? `Here's ${SURFACE_LABEL[intent.surface]}.`
    : card.emptyText ?? `Here's ${SURFACE_LABEL[intent.surface]}.`;
}

export type NavigationReply = {
  threadId: string;
  message: string;
  reply: string;
  card: SurfaceCard;
};

/**
 * Answer a navigation intent in the owner's persistent Supervisor thread.
 * Returns null when the message is not navigation - the caller then takes
 * the model path. Card rows are workspace records read through the canonical
 * domain queries, so they carry exactly the permissions those surfaces have.
 */
export async function respondToNavigation(auth: AuthContext, message: string): Promise<NavigationReply | null> {
  const intent = parseNavigationIntent(message);
  if (!intent) return null;
  const card = await buildSurfaceCard(auth, intent);
  const reply = replyText(intent, card);
  const threadId = await withTransaction(async (tx) => {
    const id = await getOrCreateSupervisorThread(auth, tx);
    await tx.insert(messages).values({
      workspaceId: auth.workspaceId,
      threadId: id,
      role: "user",
      content: message,
    });
    await tx.insert(messages).values({
      workspaceId: auth.workspaceId,
      threadId: id,
      role: "assistant",
      content: reply,
      parts: [{ type: SURFACE_CARD_PART, card }],
    });
    await tx.update(threads).set({ updatedAt: new Date(), updatedBy: auth.userId }).where(eq(threads.id, id));
    /*
     * No queueThreadSync here on purpose: the outbox worker syncs as the
     * workspace OWNER, so an auto-sync would project this private exchange
     * into workspace-shared knowledge and search. Projection happens only
     * through the owner's explicit "Add to knowledge" action.
     */
    await recordAudit(
      auth,
      {
        action: "conversation.navigation_answered",
        subjectType: "thread",
        subjectId: id,
        summary: `Navigation answered in-thread: ${intent.kind === "open_note" ? `note search "${intent.query}"` : intent.surface}`,
      },
      tx,
    );
    return id;
  });
  return { threadId, message, reply, card };
}
