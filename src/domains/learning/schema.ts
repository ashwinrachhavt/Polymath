import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";
import { artifacts } from "../knowledge/schema";

/*
 * Learning is separate from knowledge on purpose. An artifact is something the
 * owner made or read; a learning item is something they are trying to retain,
 * and an attempt is a measured outcome. Keeping generation, approval, and
 * measured recall in different tables is what stops "I made a flashcard" from
 * reading as "I know this".
 */

export const learningItemKind = pgEnum("learning_item_kind", ["flashcard", "quiz_question", "exercise"]);
export const learningItemStatus = pgEnum("learning_item_status", [
  "proposed",
  "approved",
  "retired",
  "stale",
]);
export const learningResult = pgEnum("learning_result", [
  "forgot",
  "struggled",
  "recalled",
  "explained",
  "applied",
]);
export const planStatus = pgEnum("plan_status", ["active", "paused", "completed", "abandoned"]);

export const learningDecks = pgTable(
  "learning_decks",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    description: text("description"),
    /** The artifact or dossier this deck was drawn from, when there is one. */
    sourceArtifactId: uuid("source_artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    ...mutable,
  },
  (t) => [uniqueIndex("learning_decks_workspace_name_key").on(t.workspaceId, t.name)],
);

/*
 * An item is generated, then approved by the owner, then scheduled. Approval
 * is a separate act from generation because a model's question is a proposal
 * about what is worth knowing, not a fact.
 */
export const learningItems = pgTable(
  "learning_items",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    deckId: uuid("deck_id").references(() => learningDecks.id, { onDelete: "set null" }),
    kind: learningItemKind("kind").notNull().default("flashcard"),
    prompt: text("prompt").notNull(),
    answer: text("answer"),
    /** Source evidence: the passage this item tests, so it can be corrected. */
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    sourceQuote: text("source_quote"),
    /*
     * A quiz question is a prompt, four options and one correct index. They are
     * columns, not JSON in `answer`, because the quiz UI reads answerIndex and
     * the approval surface counts options. A flashcard leaves all three null.
     */
    options: jsonb("options").$type<string[]>(),
    answerIndex: integer("answer_index"),
    /** Why the correct answer is correct, shown after an attempt. */
    explanation: text("explanation"),
    /*
     * Dedupe key for a generated item, hashed the way zettelDedupeKey is: the
     * source quote can exceed the 2704-byte btree row limit, so the index is on
     * a digest, not on the text.
     */
    dedupeKey: text("dedupe_key"),
    status: learningItemStatus("status").notNull().default("proposed"),
    /** Review scheduling (SM-2 style). Null until first reviewed. */
    dueOn: date("due_on"),
    intervalDays: integer("interval_days").notNull().default(0),
    easeFactor: text("ease_factor").notNull().default("2.5"),
    reviewCount: integer("review_count").notNull().default(0),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    /** Set when the source material changed and the item may no longer be true. */
    staleReason: text("stale_reason"),
    ...mutable,
  },
  (t) => [
    // Partial index: the review queue is approved items that are due.
    index("learning_items_due_idx")
      .on(t.workspaceId, t.dueOn)
      .where(sql`status = 'approved'`),
    index("learning_items_deck_idx").on(t.deckId),
    // Regenerating a quiz must not duplicate an item. Null keys (a hand-written
    // flashcard) are outside the rule, so the index is partial.
    uniqueIndex("learning_items_dedupe_key")
      .on(t.deckId, t.dedupeKey)
      .where(sql`dedupe_key is not null`),
    // A quiz question without options and an answer index cannot be taken.
    check(
      "learning_items_quiz_shape",
      sql`kind <> 'quiz_question' or (options is not null and answer_index is not null)`,
    ),
  ],
);

/** One measured attempt. The history is the signal; the counter is a cache. */
export const learningAttempts = pgTable(
  "learning_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => learningItems.id, { onDelete: "cascade" }),
    /** Optional: attempts made during a focus session link back to it. */
    focusSessionId: uuid("focus_session_id"),
    result: learningResult("result").notNull(),
    responseText: text("response_text"),
    durationMs: integer("duration_ms"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    ...recorded,
  },
  (t) => [index("learning_attempts_item_idx").on(t.itemId, t.reviewedAt)],
);

export const learningPlans = pgTable(
  "learning_plans",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    title: text("title").notNull(),
    /** What the plan is for, and how the owner will know it worked. */
    objective: text("objective"),
    status: planStatus("status").notNull().default("active"),
    deckIds: jsonb("deck_ids").notNull().default([]),
    targetDate: date("target_date"),
    ...mutable,
  },
  (t) => [index("learning_plans_active_idx").on(t.workspaceId, t.status, t.targetDate)],
);
