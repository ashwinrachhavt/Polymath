import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { concepts } from "./schema";

/*
 * A concept is one dictionary entry (`concepts`, sense "domain"): the same row
 * an Idea upserts when it is made, so an Idea titled "Idempotency" and a quiz
 * question about idempotency share one id. Its id is the stable handle the
 * learning domain links questions, cards and explanations to.
 */

const MAX_CONCEPT_NAME_CHARS = 80;

/** The stored form of a concept name: trimmed, single-spaced, bounded. Empty when nothing usable is left. */
export function conceptName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CONCEPT_NAME_CHARS).trim();
}

/** Two names that differ only in letter case name the same concept. */
export function conceptKey(name: string): string {
  return conceptName(name).toLowerCase();
}

/**
 * The id of each named concept in this workspace, creating the ones that do
 * not exist yet. Keys of the result are `conceptKey(name)`; blank names are
 * left out. An existing entry is reused whatever its letter case.
 */
export async function resolveConceptIds(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  names: readonly string[],
  tx: TxDrizzle,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const stored = conceptName(name);
    if (stored) byKey.set(stored.toLowerCase(), byKey.get(stored.toLowerCase()) ?? stored);
  }
  const keys = [...byKey.keys()];
  if (keys.length === 0) return new Map();

  const scope = and(
    eq(concepts.workspaceId, auth.workspaceId),
    eq(concepts.sense, "domain"),
    inArray(sql`lower(${concepts.term})`, keys),
  );
  const read = () =>
    tx
      .select({ id: concepts.id, term: concepts.term })
      .from(concepts)
      .where(scope)
      // The oldest entry wins when two differ only by case, so the id never moves.
      .orderBy(concepts.createdAt, concepts.id);

  const ids = new Map<string, string>();
  for (const row of await read()) if (!ids.has(row.term.toLowerCase())) ids.set(row.term.toLowerCase(), row.id);
  const missing = keys.filter((key) => !ids.has(key));
  if (missing.length === 0) return ids;

  await tx
    .insert(concepts)
    .values(
      missing.map((key) => ({
        workspaceId: auth.workspaceId,
        term: byKey.get(key)!,
        sense: "domain" as const,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })),
    )
    .onConflictDoNothing({ target: [concepts.workspaceId, concepts.term, concepts.sense] });
  for (const row of await read()) if (!ids.has(row.term.toLowerCase())) ids.set(row.term.toLowerCase(), row.id);
  return ids;
}

/** Names generation is asked to reuse, newest first, so one idea keeps one name across quizzes, decks and Ideas. */
export async function recentConceptNames(auth: Pick<AuthContext, "workspaceId">, limit = 40): Promise<string[]> {
  const rows = await db
    .select({ term: concepts.term })
    .from(concepts)
    .where(and(eq(concepts.workspaceId, auth.workspaceId), eq(concepts.sense, "domain")))
    .orderBy(desc(concepts.updatedAt), concepts.id)
    .limit(limit);
  return rows.map((row) => row.term);
}
