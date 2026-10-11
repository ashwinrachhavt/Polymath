import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";

/*
 * Money is `numeric`, not floating point, and it is reserved before paid work
 * starts and settled after. A reservation is what makes the budget ceiling
 * hold under concurrent runs: the row is the claim, so two runs cannot both
 * spend the last dollar.
 */

export const reservationStatus = pgEnum("reservation_status", [
  "reserved",
  "settled",
  "released",
  "expired",
]);

export const modelRateCards = pgTable(
  "model_rate_cards",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** USD per million tokens. */
    inputPerMillion: numeric("input_per_million", { precision: 12, scale: 6 }).notNull(),
    outputPerMillion: numeric("output_per_million", { precision: 12, scale: 6 }).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    ...mutable,
  },
  (t) => [uniqueIndex("model_rate_cards_key").on(t.workspaceId, t.provider, t.model, t.effectiveFrom)],
);

export const spendingPolicies = pgTable(
  "spending_policies",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    dailyCeilingUsd: numeric("daily_ceiling_usd", { precision: 12, scale: 4 }),
    monthlyCeilingUsd: numeric("monthly_ceiling_usd", { precision: 12, scale: 4 }),
    perRunCeilingUsd: numeric("per_run_ceiling_usd", { precision: 12, scale: 4 }),
    /** What happens at the ceiling: pause the agent, or fail the run. */
    onExceeded: text("on_exceeded").notNull().default("pause"),
    ...mutable,
  },
  (t) => [uniqueIndex("spending_policies_workspace_key").on(t.workspaceId)],
);

export const spendingReservations = pgTable(
  "spending_reservations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id"),
    /** Worst-case estimate, reserved up front. */
    reservedUsd: numeric("reserved_usd", { precision: 12, scale: 6 }).notNull(),
    settledUsd: numeric("settled_usd", { precision: 12, scale: 6 }),
    status: reservationStatus("status").notNull().default("reserved"),
    model: text("model"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // Partial index: available budget is the sum of open reservations.
    index("spending_reservations_open_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`status = 'reserved'`),
    index("spending_reservations_run_idx").on(t.runId),
  ],
);

/*
 * Append-only settlement ledger. The running total is derived, never stored —
 * a cached balance is a balance that drifts.
 */
export const spendSettlements = pgTable(
  "spend_settlements",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => spendingReservations.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    amountUsd: numeric("amount_usd", { precision: 12, scale: 6 }).notNull(),
    model: text("model"),
    /** Token counts, when the provider reports them. */
    usage: jsonb("usage"),
    ...recorded,
  },
  (t) => [index("spend_settlements_reservation_idx").on(t.reservationId)],
);
