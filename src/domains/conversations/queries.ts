import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentProfiles, messages, threads } from "@/domains/agents/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";

/*
 * Read queries for the conversations surface (ASH-140 D04). Threads and
 * messages are durable in Postgres - nothing here reads browser-local state -
 * so a reload, another device, or another session reads the same timeline.
 * Counts and last-activity are derived in SQL, never stored: a stored
 * denormalization is a count that drifts.
 */

export type ConversationSummary = {
  id: string;
  title: string | null;
  profileName: string;
  subjectType: string | null;
  subjectId: string | null;
  updatedAt: Date;
  messageCount: number;
  lastMessageAt: Date | null;
};

export async function listConversations(auth: AuthContext): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: threads.id,
      title: threads.title,
      updatedAt: threads.updatedAt,
      subjectType: threads.subjectType,
      subjectId: threads.subjectId,
      profileName: agentProfiles.name,
    })
    .from(threads)
    .innerJoin(agentProfiles, eq(agentProfiles.id, threads.agentProfileId))
    .where(and(eq(threads.workspaceId, auth.workspaceId), isNull(threads.archivedAt)))
    .orderBy(desc(threads.updatedAt))
    .limit(50);
  if (rows.length === 0) return [];

  const stats = await db
    .select({
      threadId: messages.threadId,
      messageCount: sql<number>`count(*)::int`,
      lastMessageAt: sql<Date | null>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(
      and(eq(messages.workspaceId, auth.workspaceId), inArray(messages.threadId, rows.map((r) => r.id))),
    )
    .groupBy(messages.threadId);
  const byThread = new Map(stats.map((s) => [s.threadId, s]));

  return rows.map((row) => ({
    ...row,
    messageCount: byThread.get(row.id)?.messageCount ?? 0,
    lastMessageAt: byThread.get(row.id)?.lastMessageAt ?? null,
  }));
}

export type ConversationTimeline = {
  thread: {
    id: string;
    title: string | null;
    profileName: string;
    createdAt: Date;
    updatedAt: Date;
  };
  entries: Array<{
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string | null;
    createdAt: Date;
  }>;
};

/** One thread with its message timeline; null when the thread is not in this workspace. */
export async function getConversation(auth: AuthContext, threadId: string): Promise<ConversationTimeline | null> {
  const [thread] = await db
    .select({
      id: threads.id,
      title: threads.title,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
      profileName: agentProfiles.name,
    })
    .from(threads)
    .innerJoin(agentProfiles, eq(agentProfiles.id, threads.agentProfileId))
    .where(and(eq(threads.id, threadId), eq(threads.workspaceId, auth.workspaceId), isNull(threads.archivedAt)))
    .limit(1);
  if (!thread) return null;

  const entries = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.workspaceId, auth.workspaceId)))
    .orderBy(asc(messages.createdAt))
    .limit(500);

  return { thread, entries };
}
