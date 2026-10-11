import { sql } from "drizzle-orm";
import {
  date,
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
 * One generic opportunity, optional typed extensions. A job application, a
 * consulting lead, and a partnership are the same shape — something that might
 * happen, with a stage, a source, and evidence — so they share a table and
 * specialize through `opportunity_extensions` rather than through parallel
 * universes.
 *
 * Stage history is append-only, and "prepared" is never conflated with
 * "submitted" or "accepted".
 */

export const opportunityStage = pgEnum("opportunity_stage", [
  "identified",
  "researching",
  "preparing",
  "submitted",
  "interviewing",
  "negotiating",
  "won",
  "lost",
  "withdrawn",
]);
export const opportunityOutcome = pgEnum("opportunity_outcome", [
  "pending",
  "accepted",
  "rejected",
  "declined",
  "expired",
]);
export const extensionKind = pgEnum("extension_kind", [
  "job_application",
  "consulting_lead",
  "partnership",
]);

export const opportunities = pgTable(
  "opportunities",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    title: text("title").notNull(),
    companyId: uuid("company_id"),
    primaryContactId: uuid("primary_contact_id"),
    /** Why it is worth pursuing, in the owner's words. */
    whyItMatters: text("why_it_matters"),
    stage: opportunityStage("stage").notNull().default("identified"),
    outcome: opportunityOutcome("outcome").notNull().default("pending"),
    /** Where it came from: a capture, a referral, a job board. */
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    /** What "a good fit" means here, stated before the decision, not after. */
    fitCriteria: jsonb("fit_criteria").notNull().default([]),
    nextCommitment: text("next_commitment"),
    nextCommitmentAt: timestamp("next_commitment_at", { withTimezone: true }),
    outcomeEvidence: jsonb("outcome_evidence"),
    tags: jsonb("tags").notNull().default([]),
    ...mutable,
  },
  (t) => [
    index("opportunities_stage_idx").on(t.workspaceId, t.stage, t.updatedAt),
    index("opportunities_company_idx").on(t.companyId),
  ],
);

/** Append-only: the stage a record passed through, when, and on what basis. */
export const opportunityStageHistory = pgTable(
  "opportunity_stage_history",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    fromStage: opportunityStage("from_stage"),
    toStage: opportunityStage("to_stage").notNull(),
    note: text("note"),
    changedBy: uuid("changed_by"),
    ...recorded,
  },
  (t) => [index("opportunity_stage_history_idx").on(t.opportunityId, t.createdAt)],
);

/*
 * Specialization lives here: one row per opportunity of a given kind holding
 * the fields that only that kind needs. Typed JSONB plus a check on `kind` —
 * not a table per kind, and not a column set that is null for most rows.
 */
export const opportunityExtensions = pgTable(
  "opportunity_extensions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    kind: extensionKind("kind").notNull(),
    /** JobApplication: { roleTitle, location, workMode, compensation, requisitionId } */
    fields: jsonb("fields").notNull().default({}),
    ...mutable,
  },
  (t) => [uniqueIndex("opportunity_extensions_kind_key").on(t.opportunityId, t.kind)],
);

/** Links to people, companies, materials, meetings, and research — typed targets, no polymorphic FK. */
export const opportunityLinks = pgTable(
  "opportunity_links",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    label: text("label"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("opportunity_links_edge_key").on(t.opportunityId, t.targetType, t.targetId),
    index("opportunity_links_target_idx").on(t.workspaceId, t.targetType, t.targetId),
  ],
);

/*
 * Jobs land in the applications domain (preparation, materials, snapshots);
 * this table is the opportunity-side view of the same journey, kept so a stage
 * change and a submission are recorded in the order they actually happened.
 */
export const opportunitiesDeadlines = pgTable(
  "opportunity_deadlines",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    dueOn: date("due_on"),
    metAt: timestamp("met_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    uniqueIndex("opportunity_deadlines_key").on(t.opportunityId, t.label),
    index("opportunity_deadlines_due_idx").on(t.workspaceId, t.dueOn).where(sql`met_at is null`),
  ],
);
