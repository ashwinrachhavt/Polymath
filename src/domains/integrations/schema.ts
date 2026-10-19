import { sql } from "drizzle-orm";
import {
  boolean,
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

/*
 * The internal mirror of what is connected. Axiom stores the Composio
 * connected-account id, the alias the owner chose, a scope summary, and health
 * — never an OAuth token. The browser sees aliases and status, nothing else.
 */

export const accountStatus = pgEnum("account_status", [
  "connecting",
  "active",
  "expired",
  "revoked",
  "error",
]);
/*
 * One row per hosted-auth attempt (D09 OAuth scaffolding). The state token is
 * the only value the browser round-trips; the provider redirect URL and, on
 * success, the Composio connected-account id land here before the account
 * row flips to active.
 */
export const connectionAttempts = pgTable(
  "connection_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    externalAccountId: uuid("external_account_id")
      .notNull()
      .references(() => externalAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    stateToken: text("state_token").notNull(),
    status: text("status").notNull().default("pending"),
    providerRedirectUrl: text("provider_redirect_url"),
    providerConnectedAccountId: text("provider_connected_account_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("connection_attempts_state_key").on(t.stateToken),
    index("connection_attempts_account_idx").on(t.workspaceId, t.externalAccountId),
  ],
);

export const triggerStatus = pgEnum("trigger_status", [
  "enabled",
  "paused",
  "errored",
  "disabled",
]);
export const syncState = pgEnum("sync_state", ["idle", "running", "partial", "failed"]);

/** Static catalog of what Axiom can talk to, seeded by migration. */
export const integrationCatalog = pgTable(
  "integration_catalog",
  {
    id: primaryId(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    /** What the provider can do, and which of those Axiom actually exposes. */
    capabilities: jsonb("capabilities").notNull().default([]),
    /** Read | prepare | external_write | sensitive_write per capability. */
    riskByCapability: jsonb("risk_by_capability").notNull().default({}),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    ...recorded,
  },
  (t) => [uniqueIndex("integration_catalog_provider_key").on(t.provider)],
);

export const externalAccounts = pgTable(
  "external_accounts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    provider: text("provider").notNull(),
    /** What the owner calls it: "work-gmail". Models choose aliases, never ids. */
    alias: text("alias").notNull(),
    /** Composio connected-account id. The token itself stays with Composio. */
    composioConnectedAccountId: text("composio_connected_account_id"),
    providerAccountId: text("provider_account_id"),
    displayName: text("display_name"),
    scopesSummary: jsonb("scopes_summary").notNull().default([]),
    status: accountStatus("status").notNull().default("connecting"),
    /** Selection for writes is explicit; nothing picks an account by default. */
    isDefaultForWrites: boolean("is_default_for_writes").notNull().default(false),
    lastHealthyAt: timestamp("last_healthy_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("external_accounts_alias_key").on(t.workspaceId, t.alias),
    uniqueIndex("external_accounts_composio_key")
      .on(t.composioConnectedAccountId)
      .where(sql`composio_connected_account_id is not null`),
    index("external_accounts_provider_idx").on(t.workspaceId, t.provider, t.status),
  ],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    externalAccountId: uuid("external_account_id")
      .notNull()
      .references(() => externalAccounts.id, { onDelete: "cascade" }),
    /** What is being synced: "messages", "events", "issues". */
    resource: text("resource").notNull(),
    /** Opaque provider cursor or sync token. */
    cursor: text("cursor"),
    state: syncState("state").notNull().default("idle"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...mutable,
  },
  (t) => [uniqueIndex("sync_cursors_resource_key").on(t.externalAccountId, t.resource)],
);

/*
 * A trigger is a standing intent to start work when something happens
 * upstream. The dedupe key plus the delivery id in webhook_inbox is what keeps
 * a replayed provider delivery from starting the work twice.
 */
export const triggers = pgTable(
  "triggers",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    externalAccountId: uuid("external_account_id").references(() => externalAccounts.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    /** Composio trigger instance id, when the provider hosts the subscription. */
    composioTriggerId: text("composio_trigger_id"),
    status: triggerStatus("status").notNull().default("paused"),
    /** Narrowing filters: labels, repos, projects. */
    filters: jsonb("filters").notNull().default({}),
    /** Bounds on how much work one trigger may start: daily cap, per-event cap. */
    budget: jsonb("budget").notNull().default({}),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    fireCount: integer("fire_count").notNull().default(0),
    ...mutable,
  },
  (t) => [
    uniqueIndex("triggers_instance_key")
      .on(t.composioTriggerId)
      .where(sql`composio_trigger_id is not null`),
    index("triggers_active_idx").on(t.workspaceId, t.status, t.eventType),
  ],
);
