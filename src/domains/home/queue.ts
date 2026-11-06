import { pageReviewQueue } from "@/domains/actions/queries";

/*
 * ASH-309: the root surface is a decision engine - one ranked queue of
 * everything waiting on the owner's judgment. Three proposers feed it:
 * agents (action proposals), capture classification (capture proposals), and
 * the owner (their own captures the system classified). Every card shows the
 * exact effect, the reason, and the risk; deciding happens in one tap on the
 * card's own surface, linked from here.
 *
 * The ranking is a pure function so the product's opinion about what
 * deserves attention first is pinned by unit tests, not embedded in SQL.
 */

export type HomeQueueCard = {
  /** Which proposer surfaced this. */
  origin: "agent";
  id: string;
  /** What's proposed, one line. */
  title: string;
  /** The exact effect approving has. */
  effect: string;
  /** Why it's proposed. */
  reason: string | null;
  riskClass: "read" | "prepare" | "external_write" | "sensitive_write" | "prohibited";
  /** Decisions with a deadline rank ahead of timeless ones. */
  expiresAt: Date | null;
  createdAt: Date;
  /** Where the card's own surface (and its edit action) lives. */
  href: string;
  /** What one-tap decide binds: the exact revision shown (CAS). */
  decision: { kind: "agent"; revisionId: string; version: number; expired: boolean };
};

/** Higher number = more of the owner's judgment at stake. */
const RISK_WEIGHT: Record<HomeQueueCard["riskClass"], number> = {
  prohibited: 4,
  sensitive_write: 3,
  external_write: 2,
  prepare: 1,
  read: 0,
};

/**
 * The queue's opinion: what expires soonest comes first (a deadline missed is
 * a decision made by default), then what risks more, then what's newest.
 * Pure and total - every tie resolves, so the homepage never reshuffles
 * between renders.
 */
export function rankHomeQueue(cards: HomeQueueCard[], now: Date = new Date()): HomeQueueCard[] {
  return [...cards].sort((a, b) => {
    const aLive = a.expiresAt !== null && a.expiresAt.getTime() > now.getTime();
    const bLive = b.expiresAt !== null && b.expiresAt.getTime() > now.getTime();
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (aLive && bLive && a.expiresAt!.getTime() !== b.expiresAt!.getTime()) {
      return a.expiresAt!.getTime() - b.expiresAt!.getTime();
    }
    const risk = RISK_WEIGHT[b.riskClass] - RISK_WEIGHT[a.riskClass];
    if (risk !== 0) return risk;
    const fresh = b.createdAt.getTime() - a.createdAt.getTime();
    if (fresh !== 0) return fresh;
    return a.id.localeCompare(b.id);
  });
}

const HOME_QUEUE_LIMIT = 50;

/** Everything waiting on the owner, normalized and ranked. */
export async function listHomeQueue(workspaceId: string): Promise<HomeQueueCard[]> {
  // The review queue's own read supplies proposals with their latest revision
  // and CAS version, so a homepage approve binds exactly what the card shows.
  const { items: actions } = await pageReviewQueue(workspaceId, {
    status: "pending",
    limit: HOME_QUEUE_LIMIT,
    offset: 0,
  });

  const cards: HomeQueueCard[] = actions
    .filter((row) => row.latestRevision !== null)
    .map((row) => ({
      origin: "agent" as const,
      id: row.id,
      title: row.title,
      effect: row.expectedEffect,
      reason: `Proposed by ${row.capability}`,
      riskClass: row.riskClass,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      href: `/reviews?proposal=${row.id}`,
      decision: {
        kind: "agent" as const,
        revisionId: row.latestRevision!.id,
        version: row.version,
        expired: row.expiresAt !== null && row.expiresAt.getTime() < Date.now(),
      },
    }));
  return rankHomeQueue(cards).slice(0, HOME_QUEUE_LIMIT);
}
