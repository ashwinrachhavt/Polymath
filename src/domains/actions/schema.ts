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
import { mutable, primaryId, recorded, recordedBy, tenantId } from "../../db/columns";

/*
 * The unified proposal → review → attempt → observation machine. Every
 * external write in Polymath goes through here, whatever the provider: the model
 * proposes, deterministic policy classifies the risk, and a human approves an
 * exact revision. An approval binds to that revision, so editing the payload
 * requires approving again.
 *
 * Success, failure, and UNKNOWN are three distinct outcomes. UNKNOWN
 * reconciles before any retry, because a retried send is a second send.
 */

export const riskClass = pgEnum("risk_class", [
  "read",
  "prepare",
  "external_write",
  "sensitive_write",
  "prohibited",
]);
export const proposalStatus = pgEnum("proposal_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export const reviewDecision = pgEnum("review_decision", ["approved", "rejected", "changes_requested"]);
export const attemptStatus = pgEnum("attempt_status", ["succeeded", "failed", "unknown"]);
export const reconciliationState = pgEnum("reconciliation_state", [
  "not_needed",
  "pending",
  "resolved",
]);

export const actionPolicies = pgTable(
  "action_policies",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Capability key, e.g. "gmail.send" or "github.create_issue". */
    capability: text("capability").notNull(),
    riskClass: riskClass("risk_class").notNull(),
    /** True only for narrowly bounded, explicitly chosen capabilities. */
    autoExecute: boolean("auto_execute").notNull().default(false),
    /** Constraints on auto-execution: recipient allowlist, max spend, dry-run first. */
    constraints: jsonb("constraints").notNull().default({}),
    ...mutable,
  },
  (t) => [uniqueIndex("action_policies_capability_key").on(t.workspaceId, t.capability)],
);

/*
 * The workspace kill switch. While engaged, nothing new executes — proposals
 * may still be created and reviewed, but the attempt step refuses.
 */
export const executionSettings = pgTable(
  "execution_settings",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    paused: boolean("paused").notNull().default(false),
    pausedReason: text("paused_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [uniqueIndex("execution_settings_workspace_key").on(t.workspaceId)],
);

export const actionProposals = pgTable(
  "action_proposals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    capability: text("capability").notNull(),
    riskClass: riskClass("risk_class").notNull(),
    status: proposalStatus("status").notNull().default("pending"),
    /** What it will act on: a record, a thread, a schedule. */
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    /** The resolved account alias, never a raw provider id. */
    accountAlias: text("account_alias"),
    title: text("title").notNull(),
    /** Human-readable description of the effect, shown in the review card. */
    expectedEffect: text("expected_effect").notNull(),
    /** Dedupe key: replaying the same intent cannot produce a second effect. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Which run produced it, when an agent did. */
    runId: uuid("run_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    /** Set when an edit invalidated a prior approval and re-review is required. */
    revisionOf: uuid("revision_of"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("action_proposals_dedupe_key").on(t.workspaceId, t.dedupeKey),
    // Partial index: the Reviews queue is the pending rows.
    index("action_proposals_pending_idx").on(t.workspaceId, t.createdAt).where(sql`status = 'pending'`),
    // The decided Reviews views filter on status and read newest first.
    index("action_proposals_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);

/*
 * Payload revisions are immutable. The approved revision is the one that
 * executes; anything after it is a new proposal awaiting its own decision.
 */
export const actionRevisions = pgTable(
  "action_revisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => actionProposals.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    /** The exact provider payload that would be sent. */
    payload: jsonb("payload").notNull(),
    /** Preview shown to the owner: rendered subject, body, diff, or summary. */
    preview: jsonb("preview"),
    ...recordedBy,
  },
  (t) => [uniqueIndex("action_revisions_number_key").on(t.proposalId, t.revisionNumber)],
);

/** The approval binds to one revision. `revisionId` is what makes that explicit. */
export const actionReviews = pgTable(
  "action_reviews",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => actionProposals.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => actionRevisions.id, { onDelete: "restrict" }),
    decision: reviewDecision("decision").notNull(),
    note: text("note"),
    reviewedBy: uuid("reviewed_by"),
    ...recorded,
  },
  (t) => [index("action_reviews_proposal_idx").on(t.proposalId, t.createdAt)],
);

export const actionAttempts = pgTable(
  "action_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => actionProposals.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => actionRevisions.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    /**
     * The duplicate-send guard. A claim is one INSERT of this key; a second
     * executor run for the same intent loses the unique index on purpose and
     * returns the attempt that already exists instead of sending again.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    status: attemptStatus("status").notNull(),
    /** Redacted provider response summary — never the raw body. */
    responseSummary: jsonb("response_summary"),
    errorCode: text("error_code"),
    reconciliation: reconciliationState("reconciliation").notNull().default("not_needed"),
    /** Provider id of whatever was created, once known. */
    providerObjectId: text("provider_object_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...recorded,
  },
  (t) => [
    uniqueIndex("action_attempts_number_key").on(t.proposalId, t.attemptNumber),
    // Scoped to the workspace so a foreign key from another tenant collides
    // with itself rather than with this one's intent.
    uniqueIndex("action_attempts_idempotency_key").on(t.workspaceId, t.idempotencyKey),
    // Partial index: the reconciliation sweep reads UNKNOWN rows that still matter.
    index("action_attempts_unresolved_idx")
      .on(t.workspaceId, t.startedAt)
      .where(sql`status = 'unknown' and reconciliation = 'pending'`),
  ],
);

/*
 * What the provider actually shows. Observations are how Polymath closes an
 * UNKNOWN: a later read of the provider proves whether the effect landed.
 */
export const providerObservations = pgTable(
  "provider_observations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    attemptId: uuid("attempt_id").references(() => actionAttempts.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").references(() => actionProposals.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerObjectId: text("provider_object_id"),
    /** "sent" | "absent" | "modified" | provider-specific. */
    observedState: text("observed_state").notNull(),
    detail: jsonb("detail"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    ...recorded,
  },
  (t) => [index("provider_observations_proposal_idx").on(t.proposalId, t.observedAt)],
);
