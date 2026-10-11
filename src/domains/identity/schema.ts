import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";
import { users } from "./tables";

/*
 * `users` and `workspaces` live in ./tables.ts — they are the root of the
 * import graph, and the shared column helpers need `workspaces`. Everything
 * below them is here.
 *
 * Clerk owns authentication; these rows are the internal identity it maps
 * onto. Clients never supply an owner id — the server resolves it from Clerk.
 */

export * from "./tables";

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member", "viewer"]);
export const membershipStatus = pgEnum("membership_status", ["invited", "active", "suspended"]);
export const appearance = pgEnum("appearance", ["light", "dark", "system"]);
export const motionPreference = pgEnum("motion_preference", ["full", "reduced"]);
export const apiClientKind = pgEnum("api_client_kind", ["companion", "machine"]);
export const apiClientStatus = pgEnum("api_client_status", ["active", "revoked"]);

export const memberships = pgTable(
  "memberships",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("owner"),
    status: membershipStatus("status").notNull().default("active"),
    ...mutable,
  },
  (t) => [uniqueIndex("memberships_workspace_user_key").on(t.workspaceId, t.userId)],
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    timezone: text("timezone").notNull().default("UTC"),
    /** ISO weekday: 1 = Monday. */
    weekStart: smallint("week_start").notNull().default(1),
    appearance: appearance("appearance").notNull().default("system"),
    motion: motionPreference("motion").notNull().default("full"),
    /** Per-category notification policy: decision_needed, deadline, conflict, blocked, unknown_action, output_ready. */
    notificationPolicy: jsonb("notification_policy"),
    modelDefaults: jsonb("model_defaults"),
    /** Daily and monthly ceilings; spending policies own enforcement. */
    budgetDefaults: jsonb("budget_defaults"),
    ...mutable,
  },
  (t) => [uniqueIndex("user_preferences_workspace_user_key").on(t.workspaceId, t.userId)],
);

/*
 * Paired browser companion and machine clients. Only the hash of a credential
 * is stored; the credential itself is shown once at pairing and never again.
 */
export const apiClients = pgTable(
  "api_clients",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    kind: apiClientKind("kind").notNull().default("companion"),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    status: apiClientStatus("status").notNull().default("active"),
    pairedAt: timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [index("api_clients_workspace_status_idx").on(t.workspaceId, t.status)],
);
