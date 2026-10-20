import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { currentExtractionSql } from "@/domains/knowledge/versions";
import { defaultQuizGenerator, QUESTIONS_PER_REQUEST, verifyCandidates, type QuizGenerator } from "@/integrations/quiz/generator";
import { learningAttempts, learningDecks, learningItems } from "./schema";
import { nextSchedule, type LearningResult } from "./sm2";

/*
 * Learning commands (PR 2). Generation proposes; approval is a separate act;
 * an attempt is a measured outcome. The three stay apart so "I made a quiz"
 * never reads as "I know this".
 *
 * Every write is one transaction: auth context -> receipt -> change -> audit.
 * Generated items land `proposed` with a hashed dedupe key, so regenerating a
 * quiz over the same source does not duplicate questions.
 */

export class LearningError extends Error {
  constructor(
    public readonly code:
      | "deck_not_found"
      | "deck_name_taken"
      | "item_not_found"
      | "item_not_proposed"
      | "item_not_approved"
      | "document_not_found"
      | "no_extraction"
      | "empty_text"
      | "invalid_result",
    message: string,
  ) {
    super(message);
    this.name = "LearningError";
  }
}

export const LEARNING_RESULTS: readonly LearningResult[] = ["forgot", "struggled", "recalled", "explained", "applied"];

/** The stored key is a digest: a quote can exceed the btree row limit. */
export async function itemDedupeKey(input: { sourceType: string; sourceId: string; quote: string }): Promise<string> {
  return sha256Hex(`${input.sourceType}:${input.sourceId}:${input.quote.trim()}`);
}

export async function createDeck(auth: AuthContext, input: { name: string; description?: string; sourceArtifactId?: string }) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new LearningError("deck_not_found", "Give the deck a name of up to 120 characters.");
  const [existing] = await db
    .select({ id: learningDecks.id })
    .from(learningDecks)
    .where(and(eq(learningDecks.workspaceId, auth.workspaceId), eq(learningDecks.name, name)))
    .limit(1);
  if (existing) throw new LearningError("deck_name_taken", "A deck with that name already exists.");
  const [deck] = await db
    .insert(learningDecks)
    .values({
      workspaceId: auth.workspaceId,
      name,
      description: input.description?.trim() || null,
      sourceArtifactId: input.sourceArtifactId ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning({ id: learningDecks.id });
  return deck;
}

export async function listDecks(auth: AuthContext) {
  return db
    .select({
      id: learningDecks.id,
      name: learningDecks.name,
      description: learningDecks.description,
      updatedAt: learningDecks.updatedAt,
      total: sql<number>`(select count(*)::int from learning_items li where li.deck_id = "learning_decks"."id" and li.status = 'approved')`,
      due: sql<number>`(select count(*)::int from learning_items li where li.deck_id = "learning_decks"."id" and li.status = 'approved' and (li.due_on is null or li.due_on <= current_date))`,
      proposed: sql<number>`(select count(*)::int from learning_items li where li.deck_id = "learning_decks"."id" and li.status = 'proposed')`,
    })
    .from(learningDecks)
    .where(and(eq(learningDecks.workspaceId, auth.workspaceId), isNull(learningDecks.archivedAt)))
    .orderBy(desc(learningDecks.updatedAt));
}

/**
 * Generates questions from one document's current extraction and stores the
 * ones the source supports. Returns the counts so the UI can say "6 of 10
 * usable" instead of implying the model produced 10.
 *
 * Batching: one provider call per QUESTIONS_PER_REQUEST questions. An
 * exhausted allowance stops the loop and reports what was produced.
 */
export async function generateQuiz(
  auth: AuthContext,
  input: { deckId: string; documentId: string; count?: number; generator?: QuizGenerator },
) {
  const [deck] = await db
    .select({ id: learningDecks.id })
    .from(learningDecks)
    .where(and(eq(learningDecks.id, input.deckId), eq(learningDecks.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!deck) throw new LearningError("deck_not_found", "No such deck.");

  const [doc] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)))
    .limit(1);
  if (!doc) throw new LearningError("document_not_found", "No such document.");

  const [extraction] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text })
    .from(documentExtractions)
    .where(and(
      eq(documentExtractions.documentId, doc.id),
      eq(documentExtractions.workspaceId, auth.workspaceId),
      eq(documentExtractions.status, "succeeded"),
      eq(documentExtractions.id, sql`(${currentExtractionSql("id")})`),
    ))
    .limit(1);
  const text = extraction?.text ?? "";
  if (!text.trim()) throw new LearningError("no_extraction", "That document has no readable text yet.");

  const count = Math.min(Math.max(input.count ?? 10, 1), 20);
  const generator = input.generator ?? defaultQuizGenerator(auth.workspaceId);

  const candidates = [];
  let requests = 0;
  let budgetStopped = false;
  for (let remaining = count; remaining > 0; remaining -= QUESTIONS_PER_REQUEST) {
    try {
      const batch = await generator.generate({ text, count: Math.min(remaining, QUESTIONS_PER_REQUEST) });
      requests += 1;
      candidates.push(...batch);
    } catch (cause) {
      // A quota stop ends the batch with what we have; any other failure is real.
      if (cause instanceof Error && /allowance exhausted/i.test(cause.message)) {
        budgetStopped = true;
        break;
      }
      throw cause;
    }
  }

  const verified = verifyCandidates(text, candidates, count);
  let created = 0;
  for (const item of verified) {
    const dedupeKey = await itemDedupeKey({ sourceType: "document", sourceId: doc.id, quote: item.quote });
    const rows = await db
      .insert(learningItems)
      .values({
        workspaceId: auth.workspaceId,
        deckId: deck.id,
        kind: "quiz_question",
        prompt: item.prompt,
        answer: item.options[item.answerIndex],
        options: item.options,
        answerIndex: item.answerIndex,
        explanation: item.explanation,
        sourceType: "document",
        sourceId: doc.id,
        sourceQuote: item.quote,
        dedupeKey,
        status: "proposed",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [learningItems.deckId, learningItems.dedupeKey] })
      .returning({ id: learningItems.id });
    created += rows.length;
  }

  await recordAudit(auth, {
    action: "learning.quiz.generated",
    subjectType: "learning_deck",
    subjectId: deck.id,
    summary: `Generated ${created} quiz item(s) from "${doc.title}"`,
    metadata: { documentId: doc.id, candidates: candidates.length, verified: verified.length, created, requests, budgetStopped },
  });

  return { deckId: deck.id, documentId: doc.id, proposed: candidates.length, verified: verified.length, created, requests, budgetStopped };
}

/** Approve a proposed item. Only approval puts it in front of the owner. */
export async function approveItem(auth: AuthContext, input: { itemId: string }) {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(learningItems)
      .set({ status: "approved", updatedAt: new Date(), updatedBy: auth.userId, version: sql`${learningItems.version} + 1` })
      .where(and(
        eq(learningItems.id, input.itemId),
        eq(learningItems.workspaceId, auth.workspaceId),
        eq(learningItems.status, "proposed"),
      ))
      .returning({ id: learningItems.id, deckId: learningItems.deckId });
    if (!row) throw new LearningError("item_not_proposed", "That item is not waiting for approval.");
    await recordAudit(auth, { action: "learning.item.approved", subjectType: "learning_item", subjectId: row.id, summary: "Approved a learning item" }, tx);
    return row;
  });
}

export async function retireItem(auth: AuthContext, input: { itemId: string; reason?: string }) {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(learningItems)
      .set({ status: "retired", staleReason: input.reason?.trim() || null, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${learningItems.version} + 1` })
      .where(and(eq(learningItems.id, input.itemId), eq(learningItems.workspaceId, auth.workspaceId)))
      .returning({ id: learningItems.id });
    if (!row) throw new LearningError("item_not_found", "No such item.");
    await recordAudit(auth, { action: "learning.item.retired", subjectType: "learning_item", subjectId: row.id, summary: "Retired a learning item" }, tx);
    return row;
  });
}

/**
 * Records one measured attempt and reschedules the item. The attempt row is
 * insert-only; the schedule is computed by the pure SM-2 function and written
 * under a version check, so two tabs grading the same card cannot both win.
 */
export async function recordAttempt(
  auth: AuthContext,
  input: { itemId: string; result: LearningResult; responseText?: string; durationMs?: number; idempotencyKey: string },
) {
  if (!LEARNING_RESULTS.includes(input.result)) {
    throw new LearningError("invalid_result", "That is not a review result.");
  }
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "recordAttempt", ...input }, async () => {
      const [item] = await tx
        .select({
          id: learningItems.id,
          status: learningItems.status,
          intervalDays: learningItems.intervalDays,
          easeFactor: learningItems.easeFactor,
          reviewCount: learningItems.reviewCount,
          version: learningItems.version,
        })
        .from(learningItems)
        .where(and(eq(learningItems.id, input.itemId), eq(learningItems.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!item) throw new LearningError("item_not_found", "No such item.");
      if (item.status !== "approved") throw new LearningError("item_not_approved", "Only an approved item can be reviewed.");

      const now = new Date();
      const schedule = nextSchedule(item, input.result, now);
      // The version guard is the claim: a concurrent grade on the same card loses.
      const updated = await tx
        .update(learningItems)
        .set({
          intervalDays: schedule.intervalDays,
          easeFactor: String(schedule.easeFactor),
          dueOn: schedule.dueOn.toISOString().slice(0, 10),
          reviewCount: item.reviewCount + 1,
          lastReviewedAt: now,
          updatedAt: now,
          updatedBy: auth.userId,
          version: sql`${learningItems.version} + 1`,
        })
        .where(and(
          eq(learningItems.id, item.id),
          eq(learningItems.workspaceId, auth.workspaceId),
          eq(learningItems.version, item.version),
        ))
        .returning({ id: learningItems.id });
      if (updated.length === 0) throw new LearningError("item_not_found", "This card changed elsewhere. Reload and try again.");

      await tx.insert(learningAttempts).values({
        workspaceId: auth.workspaceId,
        itemId: item.id,
        result: input.result,
        responseText: input.responseText?.slice(0, 2000) ?? null,
        durationMs: input.durationMs ?? null,
        reviewedAt: now,
      });
      await recordAudit(auth, { action: "learning.attempt.recorded", subjectType: "learning_item", subjectId: item.id, summary: `Reviewed a card: ${input.result}` }, tx);
      return { itemId: item.id, dueOn: schedule.dueOn.toISOString().slice(0, 10), intervalDays: schedule.intervalDays };
    });
    return value;
  });
}

/** Bulk approve, so a generated quiz is not 20 clicks. */
export async function approveItems(auth: AuthContext, input: { itemIds: string[] }) {
  const ids = [...new Set(input.itemIds)];
  if (ids.length === 0) return { approved: 0 };
  const rows = await db
    .update(learningItems)
    .set({ status: "approved", updatedAt: new Date(), updatedBy: auth.userId, version: sql`${learningItems.version} + 1` })
    .where(and(
      eq(learningItems.workspaceId, auth.workspaceId),
      inArray(learningItems.id, ids),
      eq(learningItems.status, "proposed"),
    ))
    .returning({ id: learningItems.id });
  await recordAudit(auth, {
    action: "learning.item.approved",
    subjectType: "learning_item",
    subjectId: rows[0]?.id ?? "none",
    summary: `Approved ${rows.length} learning item(s)`,
    metadata: { ids: rows.map((r) => r.id) },
  });
  return { approved: rows.length };
}
