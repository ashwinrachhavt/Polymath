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
import { artifacts } from "../knowledge/schema";
import { opportunities } from "../opportunities/schema";

/*
 * Preparation as a durable, versioned process. The distinction the schema
 * enforces is "prepared" versus "submitted": a preparation can run to
 * completion and generate every material, and nothing has been sent anywhere.
 * Submission is a proposal in the actions domain, not a column here.
 */

export const preparationStatus = pgEnum("preparation_status", [
  "draft",
  "gathering",
  "generating",
  "ready",
  "failed",
  "discarded",
]);
export const materialKind = pgEnum("material_kind", [
  "resume",
  "cover_letter",
  "portfolio",
  "answer",
  "other",
]);
export const snapshotKind = pgEnum("snapshot_kind", [
  "form_fields",
  "job_description",
  "requirements",
  "confirmation",
]);

/** A point-in-time capture of what an external page said, so analysis is reproducible. */
export const applicationSnapshots = pgTable(
  "application_snapshots",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    kind: snapshotKind("kind").notNull(),
    url: text("url"),
    contentHash: text("content_hash").notNull(),
    content: jsonb("content").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("application_snapshots_hash_key").on(t.opportunityId, t.kind, t.contentHash),
    index("application_snapshots_opportunity_idx").on(t.opportunityId, t.capturedAt),
  ],
);

export const applicationPreparations = pgTable(
  "application_preparations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    status: preparationStatus("status").notNull().default("draft"),
    /** Keyword analysis against the snapshot: { matched, missing, suggested }. */
    keywordAnalysis: jsonb("keyword_analysis"),
    /** The run that generated it, when a workflow did. */
    runId: uuid("run_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [index("application_preparations_opportunity_idx").on(t.workspaceId, t.opportunityId, t.status)],
);

/*
 * Materials are artifacts: the same versioning, the same lineage. This table
 * only records which artifact plays which role in which preparation.
 */
export const applicationMaterials = pgTable(
  "application_materials",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    preparationId: uuid("preparation_id")
      .notNull()
      .references(() => applicationPreparations.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    kind: materialKind("kind").notNull(),
    label: text("label"),
    /** True for the version chosen to be sent, once the owner has decided. */
    selected: boolean("selected").notNull().default(false),
    ...mutable,
  },
  (t) => [uniqueIndex("application_materials_key").on(t.preparationId, t.artifactId, t.kind)],
);
