import { and, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { safeCanvaDesignUrl } from "@/domains/integrations/canva/import";
import { outcomeOf, type EffectOutcome } from "./executor";
import { actionAttempts, actionProposals, actionRevisions, actionReviews, providerObservations } from "./schema";

/*
 * Reads for the Reviews queue and the Briefing's judgment panel. The queue is
 * the pending rows (the partial index on (workspace_id, created_at) carries
 * it); the decided views filter on status, indexed by 0090. A proposal card
 * shows the latest revision only: earlier revisions are immutable history,
 * and the approval binds to the newest one.
 */

export const REVIEW_QUEUE_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewQueueStatus = (typeof REVIEW_QUEUE_STATUSES)[number];

export const REVIEW_RISK_CLASSES = ["read", "prepare", "external_write", "sensitive_write"] as const;
export type ReviewRiskClass = (typeof REVIEW_RISK_CLASSES)[number];

export type ReviewQueueInput = {
  query?: string;
  /** Absent means the pending queue; "all" lists every status. */
  status?: ReviewQueueStatus | "all";
  riskClass?: ReviewRiskClass;
  limit: number;
  offset: number;
};

export type LatestRevision = {
  id: string;
  revisionNumber: number;
  payload: unknown;
  preview: unknown;
};

export type ReviewQueueItem = typeof actionProposals.$inferSelect & {
  latestRevision: LatestRevision | null;
};

export type PersistedAttemptOutcome = {
  /** The executor-vocabulary outcome of the newest attempt; null before any claim. */
  outcome: EffectOutcome | null;
  /*
   * A link renders only from a URL the provider itself returned (the
   * reconciliation observation's edit_url), validated by safeCanvaDesignUrl:
   * scheme alone is not provider identity. Absent or unsafe means no link.
   */
  designUrl: string | null;
};

/*
 * The card's persisted truth: the newest attempt per proposal, in executor
 * vocabulary, so a reload says what the decide response said. Async effects
 * (a Canva import sweeping to its terminal answer) must read the same after
 * the reviewer leaves and returns.
 */
export async function latestAttemptOutcomes(
  workspaceId: string,
  proposalIds: string[],
): Promise<Map<string, PersistedAttemptOutcome>> {
  const outcomes = new Map<string, PersistedAttemptOutcome>();
  if (proposalIds.length === 0) return outcomes;
  const attempts = await db
    .select()
    .from(actionAttempts)
    .where(and(eq(actionAttempts.workspaceId, workspaceId), inArray(actionAttempts.proposalId, proposalIds)))
    .orderBy(desc(actionAttempts.attemptNumber), desc(actionAttempts.createdAt));
  const latestByProposal = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) {
    if (!latestByProposal.has(attempt.proposalId)) latestByProposal.set(attempt.proposalId, attempt);
  }
  const importedAttemptIds = [...latestByProposal.values()]
    .filter((attempt) => attempt.status === "succeeded")
    .map((attempt) => attempt.id);
  const urlByAttempt = new Map<string, string>();
  if (importedAttemptIds.length > 0) {
    const observations = await db
      .select({ attemptId: providerObservations.attemptId, detail: providerObservations.detail })
      .from(providerObservations)
      .where(
        and(
          eq(providerObservations.workspaceId, workspaceId),
          inArray(providerObservations.attemptId, importedAttemptIds),
          eq(providerObservations.provider, "canva"),
        ),
      );
    for (const observation of observations) {
      if (!observation.attemptId || urlByAttempt.has(observation.attemptId)) continue;
      const designUrl = safeCanvaDesignUrl((observation.detail as { editUrl?: unknown } | null)?.editUrl);
      if (designUrl) urlByAttempt.set(observation.attemptId, designUrl);
    }
  }
  for (const [proposalId, attempt] of latestByProposal) {
    outcomes.set(proposalId, { outcome: outcomeOf(attempt), designUrl: urlByAttempt.get(attempt.id) ?? null });
  }
  return outcomes;
}

function queueWhere(workspaceId: string, input: Pick<ReviewQueueInput, "query" | "status" | "riskClass">): SQL {
  const parts: SQL[] = [eq(actionProposals.workspaceId, workspaceId)];
  const status = input.status ?? "pending";
  if (status !== "all") parts.push(eq(actionProposals.status, status));
  if (input.riskClass) parts.push(eq(actionProposals.riskClass, input.riskClass));
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    parts.push(or(ilike(actionProposals.title, like), ilike(actionProposals.expectedEffect, like), ilike(actionProposals.capability, like))!);
  }
  return and(...parts)!;
}

/** Newest revision per proposal id, one bounded query for the whole page. */
async function latestRevisions(workspaceId: string, proposalIds: string[]): Promise<Map<string, LatestRevision>> {
  if (proposalIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([actionRevisions.proposalId], {
      proposalId: actionRevisions.proposalId,
      id: actionRevisions.id,
      revisionNumber: actionRevisions.revisionNumber,
      payload: actionRevisions.payload,
      preview: actionRevisions.preview,
    })
    .from(actionRevisions)
    .where(and(eq(actionRevisions.workspaceId, workspaceId), inArray(actionRevisions.proposalId, proposalIds)))
    .orderBy(actionRevisions.proposalId, desc(actionRevisions.revisionNumber));
  return new Map(rows.map(({ proposalId, ...revision }) => [proposalId, revision]));
}

/** One page of proposals, newest first, with the filtered total for the pager. */
export async function pageReviewQueue(
  workspaceId: string,
  input: ReviewQueueInput,
): Promise<{ items: ReviewQueueItem[]; total: number }> {
  const where = queueWhere(workspaceId, input);
  const [proposals, [totalRow]] = await Promise.all([
    db
      .select()
      .from(actionProposals)
      .where(where)
      .orderBy(desc(actionProposals.createdAt), desc(actionProposals.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(actionProposals).where(where),
  ]);
  const revisions = await latestRevisions(
    workspaceId,
    proposals.map((p) => p.id),
  );
  return {
    items: proposals.map((p) => ({ ...p, latestRevision: revisions.get(p.id) ?? null })),
    total: totalRow?.total ?? 0,
  };
}

/** The decision receipts behind a page of cards, one bounded query. */
export async function listProposalReviews(workspaceId: string, proposalIds: string[]) {
  if (proposalIds.length === 0) return new Map<string, Array<typeof actionReviews.$inferSelect>>();
  const rows = await db
    .select()
    .from(actionReviews)
    .where(and(eq(actionReviews.workspaceId, workspaceId), inArray(actionReviews.proposalId, proposalIds)))
    .orderBy(desc(actionReviews.createdAt));
  const grouped = new Map<string, Array<typeof actionReviews.$inferSelect>>();
  for (const row of rows) {
    const list = grouped.get(row.proposalId) ?? [];
    list.push(row);
    grouped.set(row.proposalId, list);
  }
  return grouped;
}

/** The Briefing's headline number: proposals waiting on a human decision. */
export async function countPendingProposals(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(actionProposals)
    .where(and(eq(actionProposals.workspaceId, workspaceId), eq(actionProposals.status, "pending")));
  return row?.total ?? 0;
}

/** The top of the judgment queue, for the Briefing panel. */
export async function listTopPendingProposals(workspaceId: string, limit = 3) {
  return db
    .select({
      id: actionProposals.id,
      title: actionProposals.title,
      capability: actionProposals.capability,
      riskClass: actionProposals.riskClass,
      createdAt: actionProposals.createdAt,
    })
    .from(actionProposals)
    .where(and(eq(actionProposals.workspaceId, workspaceId), eq(actionProposals.status, "pending")))
    .orderBy(desc(actionProposals.createdAt))
    .limit(limit);
}
