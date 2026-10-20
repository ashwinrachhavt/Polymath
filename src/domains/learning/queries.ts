import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { documents } from "@/domains/knowledge/schema";
import { learningAttempts, learningDecks, learningItems } from "./schema";

/*
 * Learning reads. The due queue is the one query that matters: approved items
 * whose due date has arrived (or that were never reviewed), oldest first, so a
 * review session is deterministic across reloads.
 */

export type LearningItemView = {
  id: string;
  kind: string;
  prompt: string;
  answer: string | null;
  options: string[] | null;
  answerIndex: number | null;
  explanation: string | null;
  status: string;
  dueOn: string | null;
  intervalDays: number;
  reviewCount: number;
  sourceQuote: string | null;
  sourceDocumentId: string | null;
  sourceTitle: string | null;
};

export async function getDeck(auth: AuthContext, deckId: string) {
  const [deck] = await db
    .select({ id: learningDecks.id, name: learningDecks.name, description: learningDecks.description })
    .from(learningDecks)
    .where(and(eq(learningDecks.id, deckId), eq(learningDecks.workspaceId, auth.workspaceId), isNull(learningDecks.archivedAt)))
    .limit(1);
  return deck ?? null;
}

/**
 * The due queue for a deck, or for the whole workspace when no deck is named.
 * `due_on is null` means "never reviewed", which is due now.
 */
export async function dueItems(auth: AuthContext, input: { deckId?: string; limit?: number } = {}): Promise<LearningItemView[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rows = await db
    .select({
      id: learningItems.id,
      kind: learningItems.kind,
      prompt: learningItems.prompt,
      answer: learningItems.answer,
      options: learningItems.options,
      answerIndex: learningItems.answerIndex,
      explanation: learningItems.explanation,
      status: learningItems.status,
      dueOn: learningItems.dueOn,
      intervalDays: learningItems.intervalDays,
      reviewCount: learningItems.reviewCount,
      sourceQuote: learningItems.sourceQuote,
      sourceDocumentId: learningItems.sourceId,
    })
    .from(learningItems)
    .where(and(
      eq(learningItems.workspaceId, auth.workspaceId),
      eq(learningItems.status, "approved"),
      sql`(${learningItems.dueOn} is null or ${learningItems.dueOn} <= current_date)`,
      input.deckId ? eq(learningItems.deckId, input.deckId) : undefined,
    ))
    .orderBy(asc(sql`coalesce(${learningItems.dueOn}, '1970-01-01')`), asc(learningItems.id))
    .limit(limit);
  return withSourceTitles(auth, rows);
}

/** Proposed items awaiting approval, newest first. */
export async function proposedItems(auth: AuthContext, input: { deckId?: string; limit?: number } = {}): Promise<LearningItemView[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: learningItems.id,
      kind: learningItems.kind,
      prompt: learningItems.prompt,
      answer: learningItems.answer,
      options: learningItems.options,
      answerIndex: learningItems.answerIndex,
      explanation: learningItems.explanation,
      status: learningItems.status,
      dueOn: learningItems.dueOn,
      intervalDays: learningItems.intervalDays,
      reviewCount: learningItems.reviewCount,
      sourceQuote: learningItems.sourceQuote,
      sourceDocumentId: learningItems.sourceId,
    })
    .from(learningItems)
    .where(and(
      eq(learningItems.workspaceId, auth.workspaceId),
      eq(learningItems.status, "proposed"),
      input.deckId ? eq(learningItems.deckId, input.deckId) : undefined,
    ))
    .orderBy(desc(learningItems.createdAt))
    .limit(limit);
  return withSourceTitles(auth, rows);
}

/** One item with its full shape, workspace-scoped. */
export async function getItem(auth: AuthContext, itemId: string): Promise<LearningItemView | null> {
  const rows = await db
    .select({
      id: learningItems.id,
      kind: learningItems.kind,
      prompt: learningItems.prompt,
      answer: learningItems.answer,
      options: learningItems.options,
      answerIndex: learningItems.answerIndex,
      explanation: learningItems.explanation,
      status: learningItems.status,
      dueOn: learningItems.dueOn,
      intervalDays: learningItems.intervalDays,
      reviewCount: learningItems.reviewCount,
      sourceQuote: learningItems.sourceQuote,
      sourceDocumentId: learningItems.sourceId,
    })
    .from(learningItems)
    .where(and(eq(learningItems.id, itemId), eq(learningItems.workspaceId, auth.workspaceId)))
    .limit(1);
  const [view] = await withSourceTitles(auth, rows);
  return view ?? null;
}

/** Attempt history for an item, newest first. */
export async function itemAttempts(auth: AuthContext, itemId: string, limit = 20) {
  return db
    .select({
      id: learningAttempts.id,
      result: learningAttempts.result,
      responseText: learningAttempts.responseText,
      durationMs: learningAttempts.durationMs,
      reviewedAt: learningAttempts.reviewedAt,
    })
    .from(learningAttempts)
    .where(and(eq(learningAttempts.itemId, itemId), eq(learningAttempts.workspaceId, auth.workspaceId)))
    .orderBy(desc(learningAttempts.reviewedAt))
    .limit(limit);
}

/** Per-deck progress: approved, due, proposed, reviewed today. */
export async function deckProgress(auth: AuthContext, deckId: string) {
  const [row] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${learningItems.status} = 'approved')::int`,
      proposed: sql<number>`count(*) filter (where ${learningItems.status} = 'proposed')::int`,
      retired: sql<number>`count(*) filter (where ${learningItems.status} = 'retired')::int`,
      due: sql<number>`count(*) filter (where ${learningItems.status} = 'approved' and (${learningItems.dueOn} is null or ${learningItems.dueOn} <= current_date))::int`,
      reviewedToday: sql<number>`(
        select count(*)::int from ${learningAttempts} la
        where la.workspace_id = ${auth.workspaceId}
          and la.item_id = ${learningItems.id}
          and la.reviewed_at >= current_date
      )`,
    })
    .from(learningItems)
    .where(and(eq(learningItems.workspaceId, auth.workspaceId), eq(learningItems.deckId, deckId)));
  return row ?? { approved: 0, proposed: 0, retired: 0, due: 0, reviewedToday: 0 };
}

/** Resolves document titles for the items that came from a document. */
async function withSourceTitles(
  auth: AuthContext,
  rows: Array<Omit<LearningItemView, "sourceTitle">>,
): Promise<LearningItemView[]> {
  const ids = [...new Set(rows.map((r) => r.sourceDocumentId).filter((id): id is string => typeof id === "string"))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, sourceTitle: null }));
  const docs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, ids)));
  const titleById = new Map(docs.map((d) => [d.id, d.title]));
  return rows.map((r) => ({
    ...r,
    sourceTitle: r.sourceDocumentId ? (titleById.get(r.sourceDocumentId) ?? null) : null,
  }));
}
