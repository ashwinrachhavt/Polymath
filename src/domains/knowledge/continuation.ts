import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { actionProposals } from "@/domains/actions/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifacts } from "./schema";

/*
 * Continue, derived from saved state (flagship design rule 4). Nothing new
 * is stored: the list reads records that already exist (Studio drafts and
 * reviewed outputs, plus the proposals waiting on them) and derives the next
 * step, so a suggestion is always distinguishable from a commitment the owner
 * made. Discarded (archived) work stays gone, and items carry no due dates,
 * so untouched work never turns "overdue".
 *
 * A waiting revision proposal IS the next thing that happens to a piece of
 * work, even when nobody has an open session on it (the audit's Leave gap):
 * it outranks the status-derived suggestion and links to the Reviews queue,
 * where the decision lives.
 */

export type ContinuationItem = {
  artifactId: string;
  title: string;
  kind: string;
  status: "draft" | "reviewed";
  updatedAt: Date;
  /** Open artifacts.revise proposals waiting on this output. */
  pendingRevisions: number;
  /** A proposal, not a commitment; the surface labels it as a suggestion. */
  suggestedNextStep: string;
  href: string;
};

/** The next step a saved output asks for. A waiting proposal wins over the status-derived suggestion. */
export function artifactNextStep(status: string, pendingRevisions = 0): string | null {
  if (pendingRevisions > 0) return "Review the proposed revision in Reviews.";
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
  pendingRevisions?: number;
};

/** Pure derivation over artifact rows, unit-tested without a database. */
export function deriveContinuationFromArtifacts(rows: ContinuationRow[], limit = 5): ContinuationItem[] {
  return rows
    .filter((row) => artifactNextStep(row.status, row.pendingRevisions ?? 0) !== null)
    .sort((a, b) => {
      // Work with a decision waiting ranks above plain recency.
      const aWaiting = (a.pendingRevisions ?? 0) > 0 ? 1 : 0;
      const bWaiting = (b.pendingRevisions ?? 0) > 0 ? 1 : 0;
      if (aWaiting !== bWaiting) return bWaiting - aWaiting;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    })
    .slice(0, limit)
    .map((row) => {
      const pendingRevisions = row.pendingRevisions ?? 0;
      return {
        artifactId: row.id,
        title: row.title,
        kind: row.kind,
        status: row.status as "draft" | "reviewed",
        updatedAt: row.updatedAt,
        pendingRevisions,
        suggestedNextStep: artifactNextStep(row.status, pendingRevisions) as string,
        href: pendingRevisions > 0 ? "/reviews" : `/polymath/dossiers?draft=${row.id}`,
      };
    });
}

const CONTINUATION_COLUMNS = {
  id: artifacts.id,
  title: artifacts.title,
  kind: artifacts.kind,
  status: artifacts.status,
  updatedAt: artifacts.updatedAt,
} as const;

/** Continue for the workspace's Studio work: decisions waiting first, then newest change. */
export async function deriveContinuation(auth: AuthContext, limit = 5): Promise<ContinuationItem[]> {
  const pending = await db
    .select({ targetId: actionProposals.targetId, n: count() })
    .from(actionProposals)
    .where(
      and(
        eq(actionProposals.workspaceId, auth.workspaceId),
        eq(actionProposals.status, "pending"),
        eq(actionProposals.targetType, "artifact"),
      ),
    )
    .groupBy(actionProposals.targetId);
  const pendingById = new Map(pending.filter((p) => p.targetId).map((p) => [p.targetId as string, Number(p.n)]));

  const openRows = and(
    eq(artifacts.workspaceId, auth.workspaceId),
    inArray(artifacts.status, ["draft", "reviewed"]),
    sql`${artifacts.archivedAt} is null`,
  );
  const recentRows = await db
    .select(CONTINUATION_COLUMNS)
    .from(artifacts)
    .where(openRows)
    .orderBy(desc(artifacts.updatedAt))
    .limit(limit);

  // An output whose only recent activity is a new proposal still surfaces:
  // the artifact row itself has not changed, so recency alone would miss it.
  const recentIds = new Set(recentRows.map((row) => row.id));
  const missingIds = [...pendingById.keys()].filter((id) => !recentIds.has(id));
  const proposalRows = missingIds.length
    ? await db.select(CONTINUATION_COLUMNS).from(artifacts).where(and(openRows, inArray(artifacts.id, missingIds)))
    : [];

  return deriveContinuationFromArtifacts(
    [...recentRows, ...proposalRows].map((row) => ({ ...row, pendingRevisions: pendingById.get(row.id) ?? 0 })),
    limit,
  );
}
