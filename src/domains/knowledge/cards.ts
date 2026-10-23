import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { artifacts, cards, cardReviews, claims } from "./schema";
import { nextRecallDue, type RecallOutcome } from "./recall-scheduler";

/*
 * Zettel card lifecycle (Product Spec, "Zettel Cards and recall").
 *
 * Generation proposes; acceptance is a separate act by the owner, and only an
 * accepted (scheduled) card is ever due or reviewable - "I made a card" never
 * reads as "I know this". This is the same honesty rule Learning enforced,
 * carried onto the spec's zettel-native model: no decks, no plans, the source
 * note or zettel is the required citation.
 *
 * Every write is one transaction: receipt -> guarded change -> audit. The
 * guarded UPDATE carries the expected version and the states the transition
 * is allowed from, so a double-submit or a stale tab is a stale-write error,
 * never a duplicate review or a resurrected card.
 */

export class CardError extends Error {
  constructor(
    public readonly code:
      | "card_not_found"
      | "source_not_found"
      | "stale_write"
      | "not_due"
      | "empty_field",
    message: string,
  ) {
    super(message);
    this.name = "CardError";
  }
}

export const CARD_OUTCOMES: readonly RecallOutcome[] = ["correct", "wrong"];

async function sourceInWorkspace(
  tx: TxDrizzle,
  auth: AuthContext,
  artifactId: string,
  claimId?: string | null,
): Promise<string> {
  const [source] = await tx
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, auth.workspaceId),
        isNull(artifacts.archivedAt),
      ),
    )
    .limit(1);
  if (!source) throw new CardError("source_not_found", "That note does not exist in this workspace.");
  if (claimId) {
    const [claim] = await tx
      .select({ id: claims.id })
      .from(claims)
      .where(and(eq(claims.id, claimId), eq(claims.workspaceId, auth.workspaceId), eq(claims.artifactId, artifactId)))
      .limit(1);
    if (!claim) throw new CardError("source_not_found", "That claim does not exist on this source.");
  }
  return source.title;
}

export async function proposeCard(
  auth: AuthContext,
  input: {
    prompt: string;
    answer: string;
    artifactId: string;
    claimId?: string | null;
    idempotencyKey?: string;
  },
) {
  const prompt = input.prompt.trim();
  const answer = input.answer.trim();
  if (!prompt || !answer) throw new CardError("empty_field", "A card needs both a prompt and an answer.");
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, input, async () => {
      const sourceTitle = await sourceInWorkspace(tx, auth, input.artifactId, input.claimId);
      const [card] = await tx
        .insert(cards)
        .values({
          workspaceId: auth.workspaceId,
          prompt,
          answer,
          artifactId: input.artifactId,
          sourceTitle,
          claimId: input.claimId ?? null,
          state: "proposed",
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: cards.id });
      await recordAudit(
        auth,
        { action: "card.proposed", subjectType: "card", subjectId: card.id, summary: `Card proposed: ${prompt.slice(0, 80)}` },
        tx,
      );
      return card;
    });
    return value;
  });
}

type Transition = { cardId: string; expectedVersion: number; idempotencyKey?: string };

/*
 * One guarded UPDATE per transition. Zero rows back means the card moved on
 * since the caller looked, which is a stale write.
 */
async function transition(
  auth: AuthContext,
  input: Transition,
  fromStates: Array<"proposed" | "scheduled" | "suspended" | "retired">,
  patch: (now: Date) => Record<string, unknown>,
  audit: { action: string; summary: string },
) {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, input, async () => {
      const now = new Date();
      const [updated] = await tx
        .update(cards)
        .set({ ...patch(now), version: sql`${cards.version} + 1`, updatedAt: now, updatedBy: auth.userId })
        .where(
          and(
            eq(cards.id, input.cardId),
            eq(cards.workspaceId, auth.workspaceId),
            eq(cards.version, input.expectedVersion),
            sql`${cards.state} in (${sql.join(fromStates.map((s) => sql`${s}`), sql`, `)})`,
          ),
        )
        .returning({ id: cards.id });
      if (!updated) {
        throw new CardError("stale_write", "That card changed since you loaded it. Reload and try again.");
      }
      await recordAudit(auth, { action: audit.action, subjectType: "card", subjectId: updated.id, summary: audit.summary }, tx);
      return updated;
    });
    return value;
  });
}

/** Accept puts the card into circulation, due immediately. */
export async function acceptCard(auth: AuthContext, input: Transition) {
  return transition(auth, input, ["proposed"], (now) => ({ state: "scheduled", dueAt: now }), {
    action: "card.accepted",
    summary: "Card accepted into review",
  });
}

/** Suspend parks a scheduled card; it leaves the queue without losing its place in the ladder. */
export async function suspendCard(auth: AuthContext, input: Transition) {
  return transition(auth, input, ["scheduled"], () => ({ state: "suspended", dueAt: null }), {
    action: "card.suspended",
    summary: "Card suspended",
  });
}

/** Resume re-enters a suspended card as due now; the ladder state is untouched. */
export async function resumeCard(auth: AuthContext, input: Transition) {
  return transition(auth, input, ["suspended"], (now) => ({ state: "scheduled", dueAt: now }), {
    action: "card.resumed",
    summary: "Card resumed",
  });
}

/** Retire is the honest end from any live state: the card no longer matters. */
export async function retireCard(auth: AuthContext, input: Transition) {
  return transition(auth, input, ["proposed", "scheduled", "suspended"], () => ({ state: "retired", dueAt: null }), {
    action: "card.retired",
    summary: "Card retired",
  });
}

/*
 * A review is a measured outcome, not an edit: the card must be scheduled and
 * due, the attempt is appended to card_reviews, and the next due comes from
 * the scheduler - all in one transaction, so a crash mid-review cannot record
 * an outcome without moving the card (or vice versa).
 */
export async function reviewCard(
  auth: AuthContext,
  input: Transition & { outcome: RecallOutcome; responseText?: string | null; durationMs?: number | null },
) {
  if (!CARD_OUTCOMES.includes(input.outcome)) throw new CardError("stale_write", "That outcome is not reviewable.");
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, input, async () => {
      const now = new Date();
      const [card] = await tx
        .select({
          id: cards.id,
          state: cards.state,
          dueAt: cards.dueAt,
          intervalDays: cards.intervalDays,
          easeFactor: cards.easeFactor,
          reviewCount: cards.reviewCount,
          version: cards.version,
        })
        .from(cards)
        .where(and(eq(cards.id, input.cardId), eq(cards.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!card || card.version !== input.expectedVersion) {
        throw new CardError("stale_write", "That card changed since you loaded it. Reload and try again.");
      }
      if (card.state !== "scheduled" || !card.dueAt || card.dueAt > now) {
        throw new CardError("not_due", "That card is not due for review.");
      }
      const next = nextRecallDue(
        { intervalDays: card.intervalDays, easeFactor: card.easeFactor, reviewCount: card.reviewCount },
        input.outcome,
        now,
      );
      await tx.insert(cardReviews).values({
        workspaceId: auth.workspaceId,
        cardId: card.id,
        outcome: input.outcome,
        responseText: input.responseText?.trim() || null,
        durationMs: input.durationMs ?? null,
      });
      // The precheck above reads the version; this UPDATE re-guards on it.
      // If a concurrent review committed in between, zero rows match - and
      // without this check the attempt row above would be orphaned (an
      // outcome recorded against a card that never moved). Throwing rolls
      // the whole transaction back: no review row, no audit, caller retries
      // and loses the precheck cleanly.
      const [moved] = await tx
        .update(cards)
        .set({
          lastOutcome: input.outcome,
          dueAt: next.dueAt,
          intervalDays: next.intervalDays,
          easeFactor: next.easeFactor,
          reviewCount: card.reviewCount + 1,
          ...(input.outcome === "correct" ? { correctCount: sql`${cards.correctCount} + 1` } : {}),
          lastReviewedAt: now,
          version: sql`${cards.version} + 1`,
          updatedAt: now,
          updatedBy: auth.userId,
        })
        .where(and(eq(cards.id, card.id), eq(cards.version, input.expectedVersion)))
        .returning({ id: cards.id });
      if (!moved) {
        throw new CardError("stale_write", "That card changed since you loaded it. Reload and try again.");
      }
      await recordAudit(
        auth,
        { action: "card.reviewed", subjectType: "card", subjectId: card.id, summary: `Card reviewed: ${input.outcome}` },
        tx,
      );
      return { id: card.id, nextDueAt: next.dueAt };
    });
    return value;
  });
}
