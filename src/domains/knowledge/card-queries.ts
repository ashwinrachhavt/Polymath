import { and, asc, count, desc, eq, ilike, isNull, lte, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { artifacts, cards, claims } from "./schema";

/*
 * Reads for the cards surface. Every row carries its citation because a card
 * always shows where it came from: sourceTitle is the live note's title when
 * the note exists, and the denormalized snapshot taken at propose time when
 * it does not. The join is a LEFT JOIN - a card whose source was deleted
 * (artifact_id set null) or archived must still be listed and marked, never
 * silently dropped.
 *
 * Queue honesty: only a card with a live, unarchived source can be due. A
 * card whose source is archived leaves the rotation while the note is
 * archived and returns when it is unarchived; a card whose source was
 * deleted stays listed with its snapshot citation but cannot be reviewed -
 * there is nothing left to consult.
 */

export type CardListItem = {
  id: string;
  prompt: string;
  answer: string;
  state: "proposed" | "scheduled" | "suspended" | "retired";
  lastOutcome: "correct" | "wrong" | null;
  dueAt: Date | null;
  intervalDays: number;
  reviewCount: number;
  correctCount: number;
  sourceTitle: string;
  /** Null when the source note was deleted; the snapshot title remains. */
  sourceId: string | null;
  /** True when the source still exists but is archived (out of the queue). */
  sourceArchived: boolean;
  version: number;
};

const cardView = {
  id: cards.id,
  prompt: cards.prompt,
  answer: cards.answer,
  state: cards.state,
  lastOutcome: cards.lastOutcome,
  dueAt: cards.dueAt,
  intervalDays: cards.intervalDays,
  reviewCount: cards.reviewCount,
  correctCount: cards.correctCount,
  sourceTitle: sql<string>`coalesce(${artifacts.title}, ${cards.sourceTitle})`,
  sourceId: artifacts.id,
  sourceArchived: sql<boolean>`(${artifacts.id} is not null and ${artifacts.archivedAt} is not null)`,
  version: cards.version,
} as const;

/** The next card due, or null when the queue is empty. One row, one round trip. */
export async function nextDueCard(auth: AuthContext, now: Date = new Date()): Promise<CardListItem | null> {
  const [row] = await db
    .select(cardView)
    .from(cards)
    .innerJoin(artifacts, eq(artifacts.id, cards.artifactId))
    .where(
      and(
        eq(cards.workspaceId, auth.workspaceId),
        eq(cards.state, "scheduled"),
        lte(cards.dueAt, now),
        isNull(cards.archivedAt),
        isNull(artifacts.archivedAt),
      ),
    )
    .orderBy(asc(cards.dueAt))
    .limit(1);
  return row ?? null;
}

export async function countDueCards(auth: AuthContext, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cards)
    .innerJoin(artifacts, eq(artifacts.id, cards.artifactId))
    .where(
      and(
        eq(cards.workspaceId, auth.workspaceId),
        eq(cards.state, "scheduled"),
        lte(cards.dueAt, now),
        isNull(cards.archivedAt),
        isNull(artifacts.archivedAt),
      ),
    );
  return row?.n ?? 0;
}

export type CardStateFilter = "proposed" | "scheduled" | "suspended" | "retired" | "all";

export async function pageCards(
  auth: AuthContext,
  opts: { state?: CardStateFilter; query?: string; limit: number; offset: number },
): Promise<{ items: CardListItem[]; total: number }> {
  const state = opts.state && opts.state !== "all" ? opts.state : undefined;
  const conditions = [eq(cards.workspaceId, auth.workspaceId), isNull(cards.archivedAt)];
  if (state) conditions.push(eq(cards.state, state));
  if (opts.query) {
    const needle = `%${escapeLike(opts.query)}%`;
    conditions.push(or(ilike(cards.prompt, needle), ilike(cards.answer, needle))!);
  }
  const where = and(...conditions);
  const [items, [totalRow]] = await Promise.all([
    db
      .select(cardView)
      .from(cards)
      .leftJoin(artifacts, eq(artifacts.id, cards.artifactId))
      .where(where)
      .orderBy(desc(cards.updatedAt))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ n: count() }).from(cards).where(where),
  ]);
  return { items, total: totalRow?.n ?? 0 };
}

/** Header readout: what is due, what awaits acceptance, and the recent hit rate. */
export async function cardHeaderStats(auth: AuthContext, now: Date = new Date()) {
  const [due, [proposedRow], [accuracyRow]] = await Promise.all([
    countDueCards(auth, now),
    db
      .select({ n: count() })
      .from(cards)
      .where(and(eq(cards.workspaceId, auth.workspaceId), eq(cards.state, "proposed"), isNull(cards.archivedAt))),
    db
      .select({
        reviews: sql<number>`coalesce(sum(${cards.reviewCount}), 0)::int`,
        correct: sql<number>`coalesce(sum(${cards.correctCount}), 0)::int`,
      })
      .from(cards)
      .where(and(eq(cards.workspaceId, auth.workspaceId), isNull(cards.archivedAt))),
  ]);
  return { due, proposed: proposedRow?.n ?? 0, reviews: accuracyRow?.reviews ?? 0, correct: accuracyRow?.correct ?? 0 };
}

/**
 * The notes and zettels a new card can cite, most recently touched first.
 * With a query this is the search path the source picker falls back to, so
 * a source older than the first page is still reachable by name.
 */
export async function listCardSources(auth: AuthContext, opts: { query?: string; limit?: number } = {}) {
  const conditions = [
    eq(artifacts.workspaceId, auth.workspaceId),
    or(eq(artifacts.kind, "note"), eq(artifacts.kind, "zettel"))!,
    isNull(artifacts.archivedAt),
  ];
  const query = opts.query?.trim();
  if (query) conditions.push(ilike(artifacts.title, `%${escapeLike(query)}%`));
  return db
    .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind })
    .from(artifacts)
    .where(and(...conditions))
    .orderBy(desc(artifacts.updatedAt))
    .limit(opts.limit ?? 50);
}

/** The claim a card tests, when it cites one. */
export async function getCitedClaim(auth: AuthContext, claimId: string) {
  const [row] = await db
    .select({ id: claims.id, statement: claims.statement })
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.workspaceId, auth.workspaceId)))
    .limit(1);
  return row ?? null;
}
