import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifacts } from "./schema";

/*
 * Continue, derived from saved state (flagship design rule 4). Nothing new
 * is stored: the list reads records that already exist (Studio drafts and
 * reviewed outputs) and derives the next step from the status alone, so a
 * suggestion is always distinguishable from a commitment the owner made.
 * Discarded (archived) work stays gone, and items carry no due dates, so
 * untouched work never turns "overdue".
 */

export type ContinuationItem = {
  artifactId: string;
  title: string;
  kind: string;
  status: "draft" | "reviewed";
  updatedAt: Date;
  /** A proposal, not a commitment; the surface labels it as a suggestion. */
  suggestedNextStep: string;
  href: string;
};

/** The next step a saved output asks for, derived from its status alone. */
export function artifactNextStep(status: string): string | null {
  switch (status) {
    case "draft":
      return "Review it: keep the draft or discard it.";
    case "reviewed":
      return "Decide what this output becomes next.";
    default:
      return null;
  }
}

export type ContinuationRow = {
  id: string;
  title: string;
  kind: string;
  status: string;
  updatedAt: Date;
};

/** Pure derivation over artifact rows, unit-tested without a database. */
export function deriveContinuationFromArtifacts(rows: ContinuationRow[], limit = 5): ContinuationItem[] {
  return rows
    .filter((row) => artifactNextStep(row.status) !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit)
    .map((row) => ({
      artifactId: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status as "draft" | "reviewed",
      updatedAt: row.updatedAt,
      suggestedNextStep: artifactNextStep(row.status) as string,
      href: `/alfred/dossiers?draft=${row.id}`,
    }));
}

/** Continue for the workspace's Studio work, newest change first. */
export async function deriveContinuation(auth: AuthContext, limit = 5): Promise<ContinuationItem[]> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      kind: artifacts.kind,
      status: artifacts.status,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        inArray(artifacts.status, ["draft", "reviewed"]),
        sql`${artifacts.archivedAt} is null`,
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(limit);
  return deriveContinuationFromArtifacts(rows, limit);
}
