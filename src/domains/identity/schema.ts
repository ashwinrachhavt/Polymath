import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, recordedBy, tenantId } from "../../db/columns";
import { users } from "./tables";

/*
 * `users` and `workspaces` live in ./tables.ts — they are the root of the
 * import graph, and the shared column helpers need `workspaces`. Everything
 * below them is here.
 *
 * Clerk owns authentication; these rows are the internal identity it maps
 * onto. Clients never supply an owner id — the server resolves it from Clerk.
 *
 * ASH-120 F02 — canonical parties. Typed tables (`people`, `organizations`)
 * rather than a single `parties` superclass: every customer of a person row
 * wants a NOT NULL name or a person-specific column, and a superclass turns
 * those into nullable columns plus a discriminator check — an EAV with extra
 * steps. The two tables stay two, and `contact_points` and
 * `party_relationships` attach to either through composite FKs on
 * `(workspace_id, id)` so an endpoint can never cross tenants. The ADR for
 * this decision is written separately. (ASH-120 F02)
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
  (t) => [
    uniqueIndex("memberships_workspace_user_key").on(t.workspaceId, t.userId),
    // Composite reference target: a resource grant can only name a membership
    // in its own workspace.
    unique("memberships_workspace_id_id_key").on(t.workspaceId, t.id),
    // Serves the per-request authorization query (resolve.ts), which filters
    // by user_id + status; the workspace-leading unique index cannot.
    index("memberships_user_active_idx").on(t.userId).where(sql`status = 'active'`),
  ],
);

/*
 * ASH-121 AC03: custom role definitions. The key is immutable (there is no
 * update path for it), the label and description are editable, and every edit
 * appends an immutable revision pinned to a capability-catalog version, so a
 * stored assignment can always be read against the catalog it was defined
 * under. Archiving preserves history. Enforcement does not read these yet -
 * guards.ts RANK remains the authorization surface.
 */
export const roleDefinitions = pgTable(
  "role_definitions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Stable machine key, e.g. "billing_clerk". Immutable once created. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("role_definitions_workspace_key_key").on(t.workspaceId, t.key),
    // Composite reference target: a revision can only point at a definition
    // in the same workspace.
    unique("role_definitions_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/** Append-only: a role edit makes a new revision; an existing one never changes (DB-trigger enforced). */
export const roleDefinitionRevisions = pgTable(
  "role_definition_revisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    roleDefinitionId: uuid("role_definition_id").notNull(),
    revision: integer("revision").notNull(),
    /** The capability-catalog version these capabilities were validated against. */
    catalogVersion: integer("catalog_version").notNull(),
    /** string[] of capability keys from the catalog; validated in the domain layer. */
    capabilities: jsonb("capabilities").notNull(),
    ...recordedBy,
  },
  (t) => [
    foreignKey({
      name: "role_definition_revisions_definition_fk",
      columns: [t.workspaceId, t.roleDefinitionId],
      foreignColumns: [roleDefinitions.workspaceId, roleDefinitions.id],
    }).onDelete("cascade"),
    unique("role_definition_revisions_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("role_definition_revisions_definition_revision_key").on(t.roleDefinitionId, t.revision),
  ],
);

/*
 * ASH-121 AC04: resource grants. A grant binds one membership to one custom
 * role definition on one resource row, with optional expiry. Revocation is a
 * lifecycle event, not a delete: revoked rows stay for audit. The target is
 * polymorphic (target_kind + target_id), so it carries no FK - the kind list
 * plus the check constraint stop a typo inventing a kind, and the domain
 * layer validates the target's existence inside the workspace, the same
 * contract linkTargetKinds documents. Guests and team subjects are later
 * work; inheritance is deliberately absent.
 *
 * NOTHING reads these rows for authorization yet: guards.ts RANK remains the
 * only enforcement surface (ADR 0002), so this table changes no existing
 * behavior. Adoption is a later, explicitly flagged slice.
 */
export const resourceGrantTargetKinds = ["person", "organization"] as const;
export type ResourceGrantTargetKind = (typeof resourceGrantTargetKinds)[number];

export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    membershipId: uuid("membership_id").notNull(),
    roleDefinitionId: uuid("role_definition_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    ...mutable,
  },
  (t) => [
    foreignKey({
      name: "resource_grants_membership_fk",
      columns: [t.workspaceId, t.membershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "resource_grants_role_fk",
      columns: [t.workspaceId, t.roleDefinitionId],
      foreignColumns: [roleDefinitions.workspaceId, roleDefinitions.id],
    }).onDelete("cascade"),
    check(
      "resource_grants_target_kind_check",
      sql.raw(`target_kind in (${resourceGrantTargetKinds.map((k) => `'${k}'`).join(", ")})`),
    ),
    // One active grant per subject/role/target; history accumulates as
    // revoked rows, so re-granting after a revoke is a fresh row.
    uniqueIndex("resource_grants_active_key")
      .on(t.workspaceId, t.membershipId, t.targetKind, t.targetId, t.roleDefinitionId)
      .where(sql`revoked_at is null`),
    index("resource_grants_target_idx").on(t.workspaceId, t.targetKind, t.targetId),
  ],
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

export const apiClientUsage = pgTable(
  "api_client_usage",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    ...recorded,
  },
  (t) => [uniqueIndex("api_client_usage_key").on(t.clientId, t.day)],
);

/*
 * ASH-120 F02 — canonical parties, below.
 *
 * `people` are workspace-scoped natural humans; `organizations` are non-human
 * parties. Neither is globally unique by email — a person can exist in several
 * workspaces, and an email address identifies a contact point, not a person.
 * One row serves every role (contact, customer, account holder, billing
 * contact); roles are edges, not rows.
 */

export const contactPointKind = pgEnum("contact_point_kind", ["email", "phone", "url"]);

export const people = pgTable(
  "people",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    displayName: text("display_name").notNull(),
    honorific: text("honorific"),
    title: text("title"),
    ...mutable,
  },
  (t) => [
    // Unique so child tables can target (workspace_id, id) with a composite
    // FK — the check that makes a cross-tenant endpoint impossible.
    uniqueIndex("people_workspace_id_key").on(t.workspaceId, t.id),
    index("people_workspace_active_idx")
      .on(t.workspaceId, t.displayName)
      .where(sql`archived_at is null`),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    /** Normalized domain is the dedupe key; name match is second. */
    domain: text("domain"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("organizations_workspace_id_key").on(t.workspaceId, t.id),
    index("organizations_workspace_active_idx")
      .on(t.workspaceId, t.name)
      .where(sql`archived_at is null`),
    uniqueIndex("organizations_workspace_domain_key")
      .on(t.workspaceId, t.domain)
      .where(sql`domain is not null`),
    // The connections import matches organizations case-insensitively. The
    // name index above is case-sensitive and cannot serve that lookup.
    index("organizations_workspace_lower_name_idx")
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`archived_at is null`),
  ],
);

/*
 * Person → Organization employment. `party_relationships` cannot hold this:
 * its one-side check forbids both endpoints at once, because it classifies a
 * single party against the workspace's business. This table holds the
 * two-ended fact — who works where — and is the reason the import path can
 * file a contact under a company without inventing a second contact table.
 *
 * `ended_at` null means current; a job change closes the old edge and opens a
 * new one rather than overwriting history.
 */
export const partyEmployment = pgTable(
  "party_employment",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    personId: uuid("person_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    title: text("title"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // Composite FKs on (workspace_id, id): a cross-tenant employment edge is a
    // constraint violation, not an application check someone forgets to call.
    foreignKey({
      name: "party_employment_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "party_employment_organization_fk",
      columns: [t.workspaceId, t.organizationId],
      foreignColumns: [organizations.workspaceId, organizations.id],
    }).onDelete("cascade"),
    index("party_employment_person_idx").on(t.personId, t.endedAt),
    index("party_employment_organization_idx").on(t.organizationId, t.endedAt),
    // One current edge per person per org, so the import's onConflictDoNothing
    // is safe against a concurrent run. A rehire is a new row: the old edge is
    // closed (ended_at set) and no longer participates in this index.
    uniqueIndex("party_employment_current_key")
      .on(t.workspaceId, t.personId, t.organizationId)
      .where(sql`ended_at is null`),
  ],
);

/*
 * Business edges between parties — customer, prospect, vendor, partner.
 * Classification only: nothing here grants authorization. Authorization lives
 * in memberships, api_clients, and action policy, never in a relationship row.
 */
export const partyRelationshipKind = pgEnum("party_relationship_kind", [
  "customer",
  "prospect",
  "vendor",
  "partner",
]);

export const partyRelationshipStatus = pgEnum("party_relationship_status", [
  "active",
  "ended",
]);

export const partyRelationships = pgTable(
  "party_relationships",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: partyRelationshipKind("kind").notNull().default("prospect"),
    status: partyRelationshipStatus("status").notNull().default("active"),
    personId: uuid("person_id"),
    organizationId: uuid("organization_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // A relationship has at least one side, and both sides belong to this
    // workspace — the composite FKs make a cross-tenant endpoint impossible.
    check("party_relationships_one_side_check", sql`(person_id is null) <> (organization_id is null)`),
    foreignKey({
      name: "party_relationships_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    })
      .onDelete("cascade"),
    foreignKey({
      name: "party_relationships_organization_fk",
      columns: [t.workspaceId, t.organizationId],
      foreignColumns: [organizations.workspaceId, organizations.id],
    })
      .onDelete("cascade"),
    index("party_relationships_person_idx").on(t.personId, t.kind),
    index("party_relationships_organization_idx").on(t.organizationId, t.kind),
  ],
);

/*
 * Emails, phones, and urls attached to a person or an organization. A value
 * identifies a contact point, never a party: no unique index on `value`, and
 * no auto-linking on equality. Exactly one primary per party per kind.
 */
export const contactPoints = pgTable(
  "contact_points",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: contactPointKind("kind").notNull(),
    /** Stored lowercased for email; verbatim otherwise. */
    value: text("value").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isVerified: boolean("is_verified").notNull().default(false),
    label: text("label"),
    personId: uuid("person_id"),
    organizationId: uuid("organization_id"),
    ...mutable,
  },
  (t) => [
    // Exactly one side, and both FK columns are composite on (workspace_id,
    // id) — the same tenant fence party_relationships has.
    check("contact_points_one_side_check", sql`(person_id is null) <> (organization_id is null)`),
    foreignKey({
      name: "contact_points_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    })
      .onDelete("cascade"),
    foreignKey({
      name: "contact_points_organization_fk",
      columns: [t.workspaceId, t.organizationId],
      foreignColumns: [organizations.workspaceId, organizations.id],
    })
      .onDelete("cascade"),
    // Exactly one primary per party per kind. Two indexes, not one over both
    // sides: the one-side check leaves the other column NULL, and Postgres
    // btree treats NULLs as distinct — a combined index would never fire.
    uniqueIndex("contact_points_primary_person_key")
      .on(t.personId, t.kind)
      .where(sql`is_primary and organization_id is null`),
    uniqueIndex("contact_points_primary_organization_key")
      .on(t.organizationId, t.kind)
      .where(sql`is_primary and person_id is null`),
    index("contact_points_value_idx").on(t.kind, t.value),
  ],
);

/*
 * A provider identity (Clerk, a connector, an OAuth account). `verified` is
 * set only by code that saw the provider confirm the address — never by email
 * equality with a contact_point. Unverified equality links nothing, ever.
 */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email"),
    verified: boolean("verified").notNull().default(false),
    accountId: uuid("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...recordedBy,
  },
  (t) => [
    // Scoped, not global: the same human legitimately exists in several
    // workspaces (ADR 0001), so (provider, provider_account_id) must be
    // unique only inside a tenant. Two people in one workspace cannot share
    // one provider account.
    uniqueIndex("external_identities_workspace_provider_key")
      .on(t.workspaceId, t.provider, t.providerAccountId),
    index("external_identities_email_idx").on(t.workspaceId, t.email),
  ],
);

/*
 * The explicit, reviewed account↔person link. It is written only from a
 * verified external identity or a human decision — there is no path where
 * matching email strings create one.
 */
export const accountPersonLinks = pgTable(
  "account_person_links",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    /** How the link was established: verified identity or explicit review. */
    method: text("method").notNull().default("verified"),
    ...recordedBy,
  },
  (t) => [
    // Composite FK: the person linked must live in the link's own workspace.
    foreignKey({
      name: "account_person_links_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    })
      .onDelete("cascade"),
    // One person per account per workspace: a second link for the same
    // account must name a different person or be an edit, not a duplicate.
    uniqueIndex("account_person_links_account_key").on(t.workspaceId, t.accountId),
  ],
);
