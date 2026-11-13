import { sql } from "drizzle-orm";
import { check, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryId, recorded, recordedBy, tenantId } from "../../db/columns";
import { workspaces } from "../identity/tables";

/*
 * Entitlements, workspace-held provider keys, and the usage ledger. One owner
 * for all three so "which key serves this call, may it, and what did it cost"
 * changes in one domain (resolver.ts reads and writes them; nothing else does).
 */

export const PLANS = ["free", "pro", "own-key"] as const;
export type Plan = (typeof PLANS)[number];

/** One row per workspace that has left the default; no row means `free`. */
export const workspacePlans = pgTable(
  "workspace_plans",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    plan: text("plan").notNull().default("free"),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("workspace_plans_plan_check", sql.raw(`plan in (${PLANS.map((p) => `'${p}'`).join(", ")})`))],
);

/**
 * A workspace's own key for one provider. `sealedKey` is the secret-box
 * envelope; `last4` is the only fragment that ever reaches a client. One key
 * per (workspace, provider): saving again replaces it.
 */
export const workspaceModelKeys = pgTable(
  "workspace_model_keys",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    provider: text("provider").notNull(),
    sealedKey: text("sealed_key").notNull(),
    last4: text("last4").notNull(),
    /** When a test call last proved the key works. */
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull(),
    ...recordedBy,
  },
  (t) => [uniqueIndex("workspace_model_keys_provider_key").on(t.workspaceId, t.provider)],
);

export const KEY_SOURCES = ["own", "house"] as const;
export type KeySource = (typeof KEY_SOURCES)[number];

export const USAGE_PURPOSES = ["chat", "generation", "grading", "embedding"] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/**
 * Append-only: one row per model call. The weekly free allowance is derived
 * from these rows (house-keyed calls this week), never from a stored counter,
 * so a counter cannot drift from the evidence. `costUsd` is null only for a
 * model the catalog cannot price. `sourceRef` makes a replayed chat step a
 * no-op (the event bridge re-delivers at least once).
 */
export const modelUsageLedger = pgTable(
  "model_usage_ledger",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    keySource: text("key_source").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
    runId: uuid("run_id"),
    sourceRef: text("source_ref"),
    ...recorded,
  },
  (t) => [
    index("model_usage_ledger_workspace_week_idx").on(t.workspaceId, t.keySource, t.createdAt),
    uniqueIndex("model_usage_ledger_source_ref_key")
      .on(t.workspaceId, t.sourceRef)
      .where(sql`source_ref is not null`),
    check(
      "model_usage_ledger_key_source_check",
      sql.raw(`key_source in (${KEY_SOURCES.map((k) => `'${k}'`).join(", ")})`),
    ),
    check(
      "model_usage_ledger_purpose_check",
      sql.raw(`purpose in (${USAGE_PURPOSES.map((k) => `'${k}'`).join(", ")})`),
    ),
  ],
);
