import { sql } from "drizzle-orm";
import {
  boolean,
  index,
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
 * People and organizations. Everything asserted about a person carries where
 * it came from: what they said, what a document says, what was observed, or
 * what a model inferred. Name matching is never treated as verified identity —
 * identity resolution is reviewed.
 */

export const observationSource = pgEnum("observation_source", [
  "stated",
  "document",
  "observed",
  "agent_inferred",
]);
export const relationshipStatus = pgEnum("relationship_status", [
  "unknown",
  "cold",
  "warm",
  "active",
  "dormant",
]);
export const correspondenceDirection = pgEnum("correspondence_direction", ["inbound", "outbound"]);
export const correspondenceState = pgEnum("correspondence_state", [
  "planned",
  "drafted",
  "sent",
  "received",
  "failed",
  "cancelled",
]);
export const followUpStatus = pgEnum("follow_up_status", [
  "open",
  "done",
  "cancelled",
  "superseded",
]);

export const companies = pgTable(
  "companies",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    /** Normalized domain is the primary dedupe key; name match is second. */
    domain: text("domain"),
    description: text("description"),
    /** [{ label, value }] — websites, locations, identifiers. */
    attributes: jsonb("attributes").notNull().default([]),
    tags: jsonb("tags").notNull().default([]),
    ...mutable,
  },
  (t) => [
    index("companies_workspace_name_idx").on(t.workspaceId, t.name),
    uniqueIndex("companies_workspace_domain_key")
      .on(t.workspaceId, t.domain)
      .where(sql`domain is not null`),
  ],
);

/*
 * One contact can belong to several companies over time (a job change is a new
 * edge, not an overwrite), so the company link lives in `contact_companies`
 * rather than as a single column.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    fullName: text("full_name").notNull(),
    /** Verified identity beats fuzzy name matching, every time. */
    primaryEmail: text("primary_email"),
    phone: text("phone"),
    title: text("title"),
    location: text("location"),
    relationshipStatus: relationshipStatus("relationship_status").notNull().default("unknown"),
    /** Free-text context that does not belong in a structured field yet. */
    notes: text("notes"),
    tags: jsonb("tags").notNull().default([]),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    index("contacts_workspace_name_idx").on(t.workspaceId, t.fullName),
    uniqueIndex("contacts_workspace_email_key")
      .on(t.workspaceId, t.primaryEmail)
      .where(sql`primary_email is not null`),
  ],
);

export const contactCompanies = pgTable(
  "contact_companies",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    isCurrent: boolean("is_current").notNull().default(false),
    ...recorded,
  },
  (t) => [
    uniqueIndex("contact_companies_key").on(t.contactId, t.companyId, t.startedAt),
    index("contact_companies_company_idx").on(t.companyId),
  ],
);

export const contactObservations = pgTable(
  "contact_observations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    source: observationSource("source").notNull(),
    /** Where it came from: a capture, a correspondence row, a document. */
    evidenceType: text("evidence_type"),
    evidenceId: uuid("evidence_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    ...mutable,
  },
  (t) => [index("contact_observations_contact_idx").on(t.contactId, t.observedAt)],
);

/*
 * Correspondence is planned, then sent — never sent directly. A `planned` row
 * is what a draft proposal produces; the external send goes through Reviews
 * and comes back with a provider identity.
 */
export const correspondence = pgTable(
  "correspondence",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    projectId: uuid("project_id"),
    direction: correspondenceDirection("direction").notNull(),
    channel: text("channel").notNull().default("email"),
    subject: text("subject"),
    body: text("body"),
    state: correspondenceState("state").notNull().default("planned"),
    externalAccountId: uuid("external_account_id"),
    /** Provider message/thread id, unique per account, for replay dedupe. */
    providerObjectId: text("provider_object_id"),
    threadId: text("thread_id"),
    /** The proposal that authorized the send, when there was one. */
    actionProposalId: uuid("action_proposal_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    index("correspondence_contact_idx").on(t.workspaceId, t.contactId, t.occurredAt),
    index("correspondence_state_idx").on(t.workspaceId, t.state),
    uniqueIndex("correspondence_provider_key")
      .on(t.externalAccountId, t.providerObjectId)
      .where(sql`provider_object_id is not null`),
  ],
);

/*
 * A follow-up is a commitment with a cancellation story: when the context
 * changes (the deal closes, the thread resolves), it is `superseded`, not
 * quietly deleted, so the record of having waited remains.
 */
export const followUps = pgTable(
  "follow_ups",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    taskId: uuid("task_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    note: text("note"),
    status: followUpStatus("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    ...mutable,
  },
  (t) => [
    index("follow_ups_open_idx").on(t.workspaceId, t.status, t.dueAt),
    index("follow_ups_contact_idx").on(t.contactId),
    index("follow_ups_company_idx").on(t.companyId),
  ],
);
