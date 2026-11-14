import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryId, recorded, tenantId } from "../../db/columns";

/*
 * Coins and stones. Finishing learning and work earns coins; coins buy stones
 * from a fixed catalog of 200. `coin_ledger` is the only record of coins: a
 * balance is the sum of a person's rows, never a stored number. Enum values
 * are append-only.
 */

export const stoneTier = pgEnum("stone_tier", ["crystal", "semi_precious", "precious", "legendary"]);

export const coinReason = pgEnum("coin_reason", [
  "quiz_completed",
  "flashcard_reviewed",
  "task_completed",
  "mission_mock_completed",
  "stone_purchased",
  // Points earned under the retired reward system, carried over once by migration 0321.
  "legacy_rewards",
]);

/**
 * The catalog: one row per collectible stone, the same for every workspace.
 * Written by migrations only (seeded from scripts/stones/catalog.json); the
 * app reads it. Art lives at `/stones/<slug>.webp`. `lore` is folklore and the
 * UI labels it as such; `fact` is mineralogy.
 */
export const stones = pgTable(
  "stones",
  {
    slug: text("slug").primaryKey(),
    name: text("name").notNull(),
    family: text("family").notNull(),
    formula: text("formula").notNull(),
    color: text("color").notNull(),
    /** Mohs, as written by mineralogists: "7" or "5.5–6". */
    hardness: text("hardness").notNull(),
    origin: text("origin").notNull(),
    fact: text("fact").notNull(),
    lore: text("lore").notNull(),
    tier: stoneTier("tier").notNull(),
    price: integer("price").notNull(),
    /** Display order on the wall: by tier, then price, then name. */
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("stones_name_key").on(t.name),
    uniqueIndex("stones_position_key").on(t.position),
    check("stones_price_positive", sql`${t.price} > 0`),
  ],
);

/*
 * Append-only. Every row names the event that caused it in `idempotency_key`
 * (unique per person), so replaying a completion or a purchase cannot move a
 * balance twice. Earning rows are positive; a purchase is the only negative
 * row, and the check keeps that pairing honest.
 */
export const coinLedger = pgTable(
  "coin_ledger",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id").notNull(),
    amount: integer("amount").notNull(),
    reason: coinReason("reason").notNull(),
    /** The record that earned or spent it: quiz attempt, flashcard, task, mock session, stone slug. */
    subjectId: text("subject_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("coin_ledger_user_idempotency_key").on(t.workspaceId, t.userId, t.idempotencyKey),
    index("coin_ledger_user_created_idx").on(t.workspaceId, t.userId, t.createdAt),
    check("coin_ledger_amount_sign", sql`(${t.amount} < 0) = (${t.reason} = 'stone_purchased') and ${t.amount} <> 0`),
  ],
);

/** Which stones a person owns. Written only by a purchase, with its ledger row. */
export const stoneOwnership = pgTable(
  "stone_ownership",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id").notNull(),
    stoneSlug: text("stone_slug")
      .notNull()
      .references(() => stones.slug, { onDelete: "restrict" }),
    ledgerEntryId: uuid("ledger_entry_id")
      .notNull()
      .references(() => coinLedger.id, { onDelete: "restrict" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stone_ownership_user_stone_key").on(t.workspaceId, t.userId, t.stoneSlug),
    uniqueIndex("stone_ownership_ledger_entry_key").on(t.ledgerEntryId),
  ],
);
