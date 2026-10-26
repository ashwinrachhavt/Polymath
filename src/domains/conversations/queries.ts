import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentProfiles, messages, threads } from "@/domains/agents/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";

/*
 * Read queries for the conversations surface (ASH-140 D04). Threads and
 * messages are durable in Postgres - nothing here reads browser-local state -
 * so a reload, another device, or another session reads the same timeline.
 * Counts and last-activity are derived in SQL, never stored: a stored
 * denormalization is a count that drifts.
 */

/*
 * ASH-306: a Supervisor thread is its owner's private assistant exchange
 * (subjectType "supervisor", subjectId = the owner's user id). It is visible
 * to its owner only - the shared conversations list must not surface one
 * member's private thread to another.
 */
function supervisorThreadVisibleTo(auth: AuthContext) {
  return or(
    isNull(threads.subjectType),
    ne(threads.subjectType, "supervisor"),
    eq(threads.subjectId, auth.userId),
  );
}

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
  return (await pageConversations(auth, { limit: 50, offset: 0 })).items;
}

/** Agent names that own at least one live thread, for the profile filter. */
export async function listConversationProfiles(auth: AuthContext): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: agentProfiles.name })
    .from(threads)
    .innerJoin(agentProfiles, eq(agentProfiles.id, threads.agentProfileId))
    .where(and(eq(threads.workspaceId, auth.workspaceId), isNull(threads.archivedAt)))
    .orderBy(asc(agentProfiles.name));
  return rows.map((r) => r.name);
}

export async function pageConversations(
  auth: AuthContext,
  input: { query?: string; profile?: string; limit: number; offset: number },
): Promise<{ items: ConversationSummary[]; total: number }> {
  const filters = [eq(threads.workspaceId, auth.workspaceId), isNull(threads.archivedAt), supervisorThreadVisibleTo(auth)];
  if (input.profile) filters.push(eq(agentProfiles.name, input.profile));
  if (input.query?.trim()) filters.push(ilike(threads.title, `%${escapeLike(input.query.trim())}%`));
  const where = and(...filters);
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(threads)
    .innerJoin(agentProfiles, eq(agentProfiles.id, threads.agentProfileId))
    .where(where);
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
    .where(where)
    .orderBy(desc(threads.updatedAt), desc(threads.id))
    .limit(input.limit)
    .offset(input.offset);
  if (rows.length === 0) return { items: [], total };

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

  return {
    total,
    items: rows.map((row) => ({
      ...row,
      messageCount: byThread.get(row.id)?.messageCount ?? 0,
      lastMessageAt: byThread.get(row.id)?.lastMessageAt ?? null,
    })),
  };
}

export type ConversationTimeline = {
  thread: {
    id: string;
    title: string | null;
    profileName: string;
    createdAt: Date;
    updatedAt: Date;
    subjectType: string | null;
    subjectId: string | null;
  };
  entries: Array<{
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string | null;
    /** Structured parts (ASH-306 surface cards; engine tool calls/citations). */
    parts: unknown;
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
      subjectType: threads.subjectType,
      subjectId: threads.subjectId,
    })
    .from(threads)
    .innerJoin(agentProfiles, eq(agentProfiles.id, threads.agentProfileId))
    .where(and(eq(threads.id, threadId), eq(threads.workspaceId, auth.workspaceId), isNull(threads.archivedAt)))
    .limit(1);
  if (!thread) return null;
  // A Supervisor thread answers to its owner alone: another member's id in
  // the URL is the same "not here" as a foreign workspace's.
  if (thread.subjectType === "supervisor" && thread.subjectId !== auth.userId) return null;

  const entries = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, parts: messages.parts, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.workspaceId, auth.workspaceId)))
    .orderBy(asc(messages.createdAt))
    .limit(500);

  return { thread, entries };
}

/**
 * Render a thread timestamp as `YYYY-MM-DD HH:MMZ`. The `max(created_at)`
 * aggregate and some boundary crossings deliver an ISO string, not a Date,
 * and `.toISOString()` on a string throws for the whole screen (1e2a636,
 * then this formatter, 2026-10-20).
 */
export function formatThreadTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const at = date instanceof Date ? date : new Date(date);
  const ms = at.getTime();
  return Number.isFinite(ms) ? at.toISOString().slice(0, 16).replace("T", " ") + "Z" : "—";
}
