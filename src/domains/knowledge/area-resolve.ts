import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { areas } from "./schema";

/*
 * Resolves a requested search area (the notes search ?area= param) to the
 * declared tags the areaTags filter consumes. An area is a name plus the
 * note tags it covers (0241, declared never inferred); the search predicate
 * itself lives in retrieval.ts.
 *
 * Boundaries, by design:
 * - Resolution is tenant-scoped: only the caller's own workspace's live
 *   areas resolve. A name that matches nothing here - nonexistent,
 *   archived, or another tenant's - resolves the same way, "unavailable",
 *   so the answer never discloses whether an area exists elsewhere.
 * - Unavailable NEVER degrades to unfiltered: the low-level areaTags
 *   contract is empty-means-unfiltered, which is right for a domain API but
 *   wrong for a person's explicit selection. Callers must not search when
 *   this returns "unavailable" - they show the unavailable state with a
 *   remove-filter action instead.
 * - A resolved area whose declared tags normalize to nothing is also
 *   "unavailable": showing broad results under an "area filtered" UI would
 *   lie twice (false scope, false filtering).
 */

export type SearchAreaResolution =
  | { status: "resolved"; name: string; tags: string[] }
  | { status: "unavailable" };

/** Same normalization the areaTags predicate applies, so resolver and filter can never drift. */
function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
}

export async function resolveSearchArea(auth: AuthContext, name: string): Promise<SearchAreaResolution> {
  const trimmed = name.trim();
  if (!trimmed) return { status: "unavailable" };
  const [row] = await db
    .select({ name: areas.name, tags: areas.tags })
    .from(areas)
    .where(and(eq(areas.workspaceId, auth.workspaceId), isNull(areas.archivedAt), sql`lower(${areas.name}) = lower(${trimmed})`))
    .limit(1);
  if (!row) return { status: "unavailable" };
  const tags = normalizeTags(row.tags);
  // An area that declares no usable tags cannot filter anything; per the
  // boundary above, that is the unavailable state, not a silent unfiltered
  // search under the area's name.
  if (tags.length === 0) return { status: "unavailable" };
  return { status: "resolved", name: row.name, tags };
}

/** Live area names for the search filter control, alphabetical; tens at most (declared by the person). */
export async function listSearchAreaNames(auth: AuthContext): Promise<string[]> {
  const rows = await db
    .select({ name: areas.name })
    .from(areas)
    .where(and(eq(areas.workspaceId, auth.workspaceId), isNull(areas.archivedAt)))
    .orderBy(asc(areas.name));
  return rows.map((r) => r.name);
}
