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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, recordedBy, tenantId } from "../../db/columns";
import { blobObjects } from "../audit/schema";
import { memberships } from "../identity/schema";
// users comes from tables, not schema: identity/schema sits in a cycle with
// db/columns, and its partial evaluation under Turbopack drops the `export *`
// re-export of tables — importing users from there resolves to undefined and
// any table referencing users.id fails at module load.
import { users } from "../identity/tables";
import { artifacts } from "../knowledge/schema";

/*
 * Alfred is one agent with one profile in v1; the schema is shaped for many
 * because the boundary is the whole point. A run captures its policy snapshot
 * — profile, model, tools, budget — at start and cannot escape it.
 *
 * Visible summaries, decisions, evidence, and redacted tool arguments are
 * persisted. Hidden chain-of-thought is not, ever.
 */

export const runState = pgEnum("run_state", [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);
export const stepKind = pgEnum("step_kind", [
  "model",
  "tool",
  "question",
  "proposal",
  "artifact",
  "note",
]);
export const questionState = pgEnum("question_state", ["open", "answered", "dismissed"]);
export const messageRole = pgEnum("message_role", ["user", "assistant", "system", "tool"]);
export const memoryStatus = pgEnum("memory_status", ["proposed", "accepted", "rejected", "retired"]);
/*
 * Context manifest item kinds keep conversation, canonical records, evidence
 * and reviewed memory distinct: a `message` is never evidence, and retrieved
 * content is data, not instructions.
 */
export const manifestItemKind = pgEnum("manifest_item_kind", [
  "record",
  "artifact_version",
  "source_span",
  "memory_revision",
  "message",
]);
export const manifestItemStaleness = pgEnum("manifest_item_staleness", [
  "current",
  "superseded",
  "stale",
  "conflicting",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions"),
    /** Model routing: primary model, fallback, and per-task overrides. */
    modelPolicy: jsonb("model_policy").notNull().default({}),
    /** Feature-scoped allowlist. The full provider catalog is never handed to a model. */
    allowedTools: jsonb("allowed_tools").notNull().default([]),
    /** Aliases, never provider ids: the model picks "work-gmail". */
    allowedAccounts: jsonb("allowed_accounts").notNull().default([]),
    /** What context the profile may read: record types and scopes. */
    contextPolicy: jsonb("context_policy").notNull().default({}),
    budgetPolicy: jsonb("budget_policy").notNull().default({}),
    memoryPolicy: jsonb("memory_policy").notNull().default({}),
    /**
     * Namespaced annotations written by migrations, never by users. The
     * 2026-10-29 rename records { renamedFrom: "alfred" } here so
     * ensureProfile can resolve polymath-lineage profiles after the name
     * change, including the collision path that renames to "polymath-2".
     */
    metadata: jsonb("metadata").notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    ...mutable,
  },
  (t) => [
    uniqueIndex("agent_profiles_workspace_name_key").on(t.workspaceId, t.name),
    // Target for composite same-workspace foreign keys (migration 0150).
    unique("agent_profiles_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

/*
 * ASH-122 GA01: agent and service principals. An agent run acts under a
 * principal, never as a person: principals are not memberships, hold no role
 * and no implicit authority - every bit of authority arrives through a
 * delegation grant (agent_delegation_grants) from a human membership. A
 * service principal is the owned identity scheduled automation runs as
 * (ADR 0002: never the last editor's ambient account); its accountable human
 * is `ownerMembershipId`, required for every kind.
 *
 * The key is immutable (there is no update path for it). Status is a
 * lifecycle: suspended pauses, revoked is a permanent kill switch - a
 * revoked principal never comes back, so re-enabling automation is a new
 * principal with its own grants.
 *
 * Default off: nothing in the request path resolves these rows yet. The Eve
 * bridge and runtime admissions adopt them under ADR 0006 (PROPOSAL).
 */
export const agentPrincipalKind = pgEnum("agent_principal_kind", ["agent", "service_principal"]);
export const agentPrincipalStatus = pgEnum("agent_principal_status", ["active", "suspended", "revoked"]);

export const agentPrincipals = pgTable(
  "agent_principals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Stable machine key, e.g. "polymath" or "nightly_briefing". Immutable once created. */
    key: text("key").notNull(),
    kind: agentPrincipalKind("kind").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    /** The profile whose revisions shape this principal's behavior, if any. */
    agentProfileId: uuid("agent_profile_id"),
    /** The accountable human. Every principal has one; scheduled work always has an active owner. */
    ownerMembershipId: uuid("owner_membership_id").notNull(),
    status: agentPrincipalStatus("status").notNull().default("active"),
    ...mutable,
  },
  (t) => [
    foreignKey({
      name: "agent_principals_profile_fk",
      columns: [t.workspaceId, t.agentProfileId],
      foreignColumns: [agentProfiles.workspaceId, agentProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "agent_principals_owner_membership_fk",
      columns: [t.workspaceId, t.ownerMembershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
    }).onDelete("restrict"),
    uniqueIndex("agent_principals_workspace_key_key").on(t.workspaceId, t.key),
    // Composite reference target: a delegation grant can only name a
    // principal in its own workspace.
    unique("agent_principals_workspace_id_id_key").on(t.workspaceId, t.id),
    index("agent_principals_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

/*
 * ASH-122 GA02 + GA07: immutable bounded delegation grants. A grant is how
 * authority reaches a principal: a human membership delegates a bounded,
 * expiring ceiling (operations from the capability catalog, resources,
 * account aliases, destinations, context boundary) and the row never changes
 * after issuance - the DB trigger below freezes every column except the
 * revocation bookkeeping. Revocation is a lifecycle event, not a delete:
 * revoked rows stay for audit.
 *
 * `parentGrantId` + `delegationDepth` are the GA07 sub-agent chain: a child
 * grant must be an attenuation of its parent (the domain layer enforces the
 * subset rule), and depth is capped so a delegation chain cannot fan out
 * unboundedly. `contentHash` pins the canonical content so a tampered row is
 * detectable at authorization time.
 *
 * Default off: nothing in the request path verifies grants yet. guards.ts
 * RANK remains the only enforcement surface; the gateway slice (GA03) is the
 * first reader.
 */
export const agentDelegationGrants = pgTable(
  "agent_delegation_grants",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** The human membership delegating authority. Never a principal: agents cannot mint grants. */
    delegatorMembershipId: uuid("delegator_membership_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    /** GA07: the grant this one attenuates, if any. */
    parentGrantId: uuid("parent_grant_id"),
    delegationDepth: integer("delegation_depth").notNull().default(0),
    /** The profile revision ceiling this grant binds, if pinned at issuance. */
    profileRevisionId: uuid("profile_revision_id"),
    /** The context manifest bounding what the run may read, if bound. */
    contextManifestId: uuid("context_manifest_id"),
    /** Capability-catalog keys; validated against catalogVersion at issuance. */
    allowedOperations: jsonb("allowed_operations").notNull(),
    /** Optional bounds: "kind:uuid" resource refs, account aliases, egress destinations. Null = not delegated. */
    allowedResources: jsonb("allowed_resources"),
    allowedAccounts: jsonb("allowed_accounts"),
    allowedDestinations: jsonb("allowed_destinations"),
    catalogVersion: integer("catalog_version").notNull(),
    /** sha256 of the canonical grant content at issuance; the gateway re-checks it. */
    contentHash: text("content_hash").notNull(),
    /** Every grant expires; bounded authority has no "forever" shape. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    foreignKey({
      name: "agent_delegation_grants_delegator_fk",
      columns: [t.workspaceId, t.delegatorMembershipId],
      foreignColumns: [memberships.workspaceId, memberships.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "agent_delegation_grants_principal_fk",
      columns: [t.workspaceId, t.agentPrincipalId],
      foreignColumns: [agentPrincipals.workspaceId, agentPrincipals.id],
    }).onDelete("restrict"),
    // Self-reference, so it points at the callback's own columns: the outer
    // const is still in its temporal dead zone while pgTable() runs.
    foreignKey({
      name: "agent_delegation_grants_parent_fk",
      columns: [t.workspaceId, t.parentGrantId],
      foreignColumns: [t.workspaceId, t.id],
    }).onDelete("restrict"),
    check("agent_delegation_grants_depth_check", sql`"delegation_depth" between 0 and 3`),
    unique("agent_delegation_grants_workspace_id_id_key").on(t.workspaceId, t.id),
    index("agent_delegation_grants_principal_idx")
      .on(t.workspaceId, t.agentPrincipalId)
      .where(sql`revoked_at is null`),
    index("agent_delegation_grants_parent_idx").on(t.parentGrantId).where(sql`parent_grant_id is not null`),
  ],
);

/*
 * ASH-122 GA03 + GA10: the append-only authorization decision log. Every
 * gateway verdict - allow AND deny - lands here with the grant it cited,
 * the redacted invocation shape, and the reasons, so an inspector can answer
 * "who delegated what, why was this admitted, and what changed" (GA10)
 * without trusting logs that only record success. Immutable via the shared
 * axiom_reject_update trigger (migration 0172). No secrets and no payloads:
 * arguments live redacted in tool_invocations; this row is the verdict.
 */
export const agentAuthorizationDecisions = pgTable(
  "agent_authorization_decisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    grantId: uuid("grant_id").notNull(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    runId: uuid("run_id"),
    /** Caller-stable invocation identity, correlating to tool_invocations. */
    invocationId: text("invocation_id"),
    operation: text("operation").notNull(),
    accountAlias: text("account_alias"),
    resourceRef: text("resource_ref"),
    destination: text("destination"),
    decision: text("decision").notNull(),
    /** Why: empty on allow, the full reason list on deny. */
    reasons: jsonb("reasons").notNull().default([]),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    /** The hash the grant row pinned at decision time, for later audit against issuance. */
    grantContentHash: text("grant_content_hash").notNull(),
    ...recorded,
  },
  (t) => [
    foreignKey({
      name: "agent_authorization_decisions_grant_fk",
      columns: [t.workspaceId, t.grantId],
      foreignColumns: [agentDelegationGrants.workspaceId, agentDelegationGrants.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "agent_authorization_decisions_principal_fk",
      columns: [t.workspaceId, t.agentPrincipalId],
      foreignColumns: [agentPrincipals.workspaceId, agentPrincipals.id],
    }).onDelete("restrict"),
    check("agent_authorization_decisions_decision_check", sql`"decision" in ('allowed', 'denied')`),
    index("agent_authorization_decisions_principal_idx").on(t.workspaceId, t.agentPrincipalId, t.createdAt),
    index("agent_authorization_decisions_grant_idx").on(t.grantId),
    index("agent_authorization_decisions_denied_idx").on(t.workspaceId, t.createdAt).where(sql`decision = 'denied'`),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "restrict" }),
    title: text("title"),
    /** Record-scoped continuity: a thread about a task, project, or person. */
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    ...mutable,
  },
  (t) => [
    index("threads_workspace_updated_idx").on(t.workspaceId, t.updatedAt),
    index("threads_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId),
    index("threads_agent_profile_idx").on(t.agentProfileId),
    unique("threads_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content"),
    /** Structured parts: tool calls, attachments, citations. */
    parts: jsonb("parts"),
    runId: uuid("run_id"),
    ...recorded,
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)],
);

export const threadCheckpoints = pgTable(
  "thread_checkpoints",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** Message id the thread can be rewound to and branched from. */
    messageId: uuid("message_id"),
    label: text("label"),
    summary: text("summary"),
    ...recordedBy,
  },
  (t) => [index("thread_checkpoints_thread_idx").on(t.threadId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    agentProfileId: uuid("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "restrict" }),
    /** Retries create a new run pointing at the one they replace. */
    retryOfRunId: uuid("retry_of_run_id"),
    objective: text("objective").notNull(),
    /** Record references the objective may touch. */
    subjects: jsonb("subjects").notNull().default([]),
    state: runState("state").notNull().default("queued"),
    /**
     * The immutable agent_profile_revisions row captured at admission (ASH-117).
     * NULL only for runs that predate revisions. Fixed once set by a trigger; the
     * workspace-scoped composite foreign key lives in migration 0150.
     */
    profileRevisionId: uuid("profile_revision_id"),
    /** Frozen at start: profile, model, tools, accounts, budget, policy. */
    policySnapshot: jsonb("policy_snapshot").notNull(),
    model: text("model"),
    summary: text("summary"),
    /** Redacted failure detail. Never a raw provider payload. */
    error: text("error"),
    /** Highest event sequence written, for SSE reconnect. */
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    /**
     * The eve session this run drives. eve allocates its own `wrun_…` ids and
     * does not support caller-assigned ones, so the bridge resolves the run
     * through this column instead of assuming session id == run id.
     */
    sessionRef: text("session_ref"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /**
     * Set when the run is retired without deleting it: failed onboarding
     * interviews are hidden this way at completion instead of being removed,
     * so the audit trail (events, steps, tool calls) survives. NULL means the
     * row is a live participant in its conversation surfaces.
     */
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    index("agent_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // Partial index: the live queue is the non-terminal rows.
    index("agent_runs_active_idx").on(t.workspaceId, t.state).where(sql`state in ('queued', 'running', 'waiting_input', 'waiting_approval')`),
    index("agent_runs_thread_idx").on(t.threadId),
    unique("agent_runs_workspace_id_id_key").on(t.workspaceId, t.id),
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: stepKind("kind").notNull(),
    summary: text("summary"),
    payload: jsonb("payload"),
    durationMs: integer("duration_ms"),
    ...recorded,
  },
  (t) => [uniqueIndex("agent_steps_run_sequence_key").on(t.runId, t.sequence)],
);

/** Append-only tool results: a step's output is never edited, only superseded by a new step. */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => agentSteps.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    /** Which connected account was used, by alias. */
    accountAlias: text("account_alias"),
    /** Redacted: secrets, tokens, and raw payloads are stripped before insert. */
    arguments: jsonb("arguments"),
    result: jsonb("result"),
    ok: boolean("ok"),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms"),
    ...recorded,
  },
  (t) => [index("tool_calls_run_idx").on(t.runId, t.createdAt)],
);

/** A durable question: the run suspends and waits rather than guessing. */
export const agentQuestions = pgTable(
  "agent_questions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    /** The specific missing input, so answering is a decision rather than an essay. */
    context: text("context"),
    options: jsonb("options").notNull().default([]),
    state: questionState("state").notNull().default("open"),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: uuid("answered_by"),
    ...mutable,
  },
  (t) => [index("agent_questions_open_idx").on(t.workspaceId, t.state, t.createdAt)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** Monotonically increasing per run; the SSE cursor. */
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    data: jsonb("data"),
    /** The owner's like/dislike on a message event; null when not yet given. */
    feedback: text("feedback"),
    ...recorded,
  },
  (t) => [uniqueIndex("run_events_run_sequence_key").on(t.runId, t.sequence)],
);

/*
 * Run reviews (ASH-304): the two run-level signals that outlive the run.
 *
 * run_kind = 'critique'        the agent's own post-run note (proposed by a
 *                              separate cheap pass, dismissable, never
 *                              auto-injected into anything)
 * run_kind = 'user_feedback'   the operator's run-level verdict with reasons
 *
 * Provenance (policy_snapshot, profile_revision_id, model) is copied from the
 * run at write time so a later regression-corpus phase can replay without
 * re-deriving what the run ran under. Feedback clears back to neutral by
 * nulling verdict/reasons/note on the same row - one row per run, enforced
 * below; the history of the flips lives in the audit rows.
 */
export const runReviewKind = pgEnum("run_review_kind", ["critique", "user_feedback"]);

export const FEEDBACK_REASONS = ["wrong", "incomplete", "wrong-target", "messy", "overscoped", "other"] as const;

export const runReviews = pgTable(
  "run_reviews",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: runReviewKind("kind").notNull(),
    /** The operator's verdict. NULL on a critique row or a cleared feedback row. */
    verdict: text("verdict"),
    /** Why a thumbs-down, from FEEDBACK_REASONS. Empty when not given. */
    reasons: text("reasons").array().notNull().default([]),
    /** Optional one-liner with the verdict. */
    note: text("note"),
    /** Critique fields; all three optional, all capped (see migration check). */
    gotWrong: text("got_wrong"),
    wasThin: text("was_thin"),
    wouldDoDifferently: text("would_do_differently"),
    /** What the run ran under, copied at write time for later replay. */
    policySnapshot: jsonb("policy_snapshot"),
    profileRevisionId: uuid("profile_revision_id"),
    model: text("model"),
    /** A dismissed critique stays stored but stops rendering. */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // One feedback row per run; clearing updates it, never stacks another.
    uniqueIndex("run_reviews_one_feedback_per_run")
      .on(t.workspaceId, t.runId)
      .where(sql`kind = 'user_feedback'`),
    // One critique per run; a redelivered critique event is a no-op.
    uniqueIndex("run_reviews_one_critique_per_run")
      .on(t.workspaceId, t.runId)
      .where(sql`kind = 'critique'`),
    check("run_reviews_verdict_check", sql`verdict is null or verdict in ('up', 'down')`),
    check(
      "run_reviews_reasons_check",
      sql`reasons <@ array['wrong','incomplete','wrong-target','messy','overscoped','other']::text[]`,
    ),
    check(
      "run_reviews_field_caps",
      sql`char_length(coalesce(got_wrong, '')) <= 600 and char_length(coalesce(was_thin, '')) <= 600 and char_length(coalesce(would_do_differently, '')) <= 600 and char_length(coalesce(note, '')) <= 280`,
    ),
    index("run_reviews_run_idx").on(t.runId),
  ],
);

export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    label: text("label"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("run_artifacts_key").on(t.runId, t.artifactId),
    index("run_artifacts_artifact_idx").on(t.artifactId),
  ],
);

/*
 * A context manifest is the inspectable record of exactly what a run's
 * context contained: which record versions, artifact versions, source spans,
 * memory revisions and messages were selected, why, and under what budget.
 * Manifests and items are append-only; an intentional refresh builds a new
 * manifest rather than mutating an old one.
 */
export const contextManifests = pgTable(
  "context_manifests",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /**
     * The profile revision the context was built against. A plain column, not
     * a foreign key: this migration predates the runtime-bindings table in
     * apply order, and the reference is validated by the domain instead.
     */
    profileRevisionId: uuid("profile_revision_id"),
    purpose: text("purpose").notNull(),
    /** The policy that chose the items: record types, scopes, ordering. */
    selectionPolicy: jsonb("selection_policy").notNull().default({}),
    /** The retrieval filters actually applied, so a reader can replay the query. */
    retrievalScope: jsonb("retrieval_scope").notNull().default({}),
    /** { maxTokens, usedTokens, truncated }: the budget and what it did. */
    budget: jsonb("budget").notNull().default({}),
    itemCount: integer("item_count").notNull().default(0),
    /** Items excluded with a recorded reason (budget, staleness, revocation). */
    gapCount: integer("gap_count").notNull().default(0),
    ...recordedBy,
  },
  (t) => [
    index("context_manifests_workspace_idx").on(t.workspaceId, t.createdAt),
    index("context_manifests_run_idx").on(t.runId),
    // Tenant-composite key for items: an item can never reference a manifest
    // outside its own workspace.
    uniqueIndex("context_manifests_workspace_id_key").on(t.workspaceId, t.id),
  ],
);

export const contextManifestItems = pgTable(
  "context_manifest_items",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => contextManifests.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: manifestItemKind("kind").notNull(),
    /** The referenced row: artifact version, source, memory revision, or message id. */
    refId: uuid("ref_id").notNull(),
    /** The owning record when one exists (artifact id, claim id, thread id). */
    refParentId: uuid("ref_parent_id"),
    /** The version actually used (artifact version number, memory revision). */
    refVersion: integer("ref_version"),
    contentHash: text("content_hash"),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    selectionReason: text("selection_reason"),
    staleness: manifestItemStaleness("staleness").notNull().default("current"),
    /** False when the budget or access rules excluded the item; the gap stays inspectable. */
    included: boolean("included").notNull().default(true),
    ...recorded,
  },
  (t) => [
    uniqueIndex("context_manifest_items_ordinal_key").on(t.manifestId, t.ordinal),
    index("context_manifest_items_ref_idx").on(t.workspaceId, t.kind, t.refId),
    foreignKey({
      columns: [t.workspaceId, t.manifestId],
      foreignColumns: [contextManifests.workspaceId, contextManifests.id],
    }),
  ],
);

/** One entry of the test-results file provided at capture time. */
export type CapturedTestResult = { name: string; ok: boolean; runAt: string };

/*
 * Workbench checkpoint: the repository state an agent-authored change landed
 * as, written by scripts/workbench/capture.ts at an explicit capture point.
 * Capture is mechanical — git status/diff/log plus a provided test-results
 * file; no hooks, no model. The diff bytes live in audit.blob_objects,
 * deduped by content_hash. Append-only: a re-capture at the same commit
 * writes a new row and reuses the blob; nothing here is ever updated.
 */
export const repoCheckpoints = pgTable(
  "repo_checkpoints",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** The run whose change session produced the captured state; null when captured without a run record. */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    repoUrl: text("repo_url").notNull(),
    baseCommitSha: text("base_commit_sha").notNull(),
    commitSha: text("commit_sha").notNull(),
    /** The base..HEAD diff bytes. Set null only if the blob's retention lapses; the diff is re-derivable from the commits. */
    diffBlobId: uuid("diff_blob_id").references(() => blobObjects.id, { onDelete: "set null" }),
    testResults: jsonb("test_results").$type<CapturedTestResult[]>(),
    /** What the operator said the change was for, when they said it at all. */
    decisionNote: text("decision_note"),
    /** recorded: a human wrote decisionNote at capture time. inferred: the rationale was reconstructed afterwards. */
    decisionStatus: text("decision_status").$type<"recorded" | "inferred">().notNull().default("inferred"),
    ...recorded,
  },
  (t) => [
    index("repo_checkpoints_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("repo_checkpoints_run_idx").on(t.runId),
    check("repo_checkpoints_decision_status_check", sql`decision_status in ('recorded', 'inferred')`),
  ],
);

/*
 * Memory is reviewed, never automatic. A model's output can propose a memory;
 * only the owner makes it durable, and every revision is kept.
 */
export const memoryItems = pgTable(
  "memory_items",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    scope: text("scope").notNull().default("workspace"),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    body: text("body").notNull(),
    status: memoryStatus("status").notNull().default("proposed"),
    /** The run that proposed it, when a model did. */
    producedByRunId: uuid("produced_by_run_id"),
    ...mutable,
  },
  (t) => [index("memory_items_status_idx").on(t.workspaceId, t.status, t.updatedAt)],
);

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    memoryItemId: uuid("memory_item_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    changedBy: uuid("changed_by"),
    reason: text("reason"),
    ...recorded,
  },
  (t) => [index("memory_revisions_item_idx").on(t.memoryItemId, t.createdAt)],
);

export const memoryReviews = pgTable(
  "memory_reviews",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    memoryItemId: uuid("memory_item_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    /** accepted | rejected | retired — the decision on the proposed memory. */
    decision: text("decision").notNull(),
    note: text("note"),
    decidedBy: uuid("decided_by"),
    ...recorded,
  },
  (t) => [index("memory_reviews_item_idx").on(t.memoryItemId, t.createdAt)],
);

/*
 * Onboarding: one interview that shapes the workspace's supervisor agent.
 * The flow's state lives here so a half-finished onboarding resumes; what it
 * learns is written to agent_profiles (name, description, instructions), never
 * stored twice. The brief column is provenance for what onboarding produced,
 * not a second source of truth for what the agent is.
 */
export const onboardingSessions = pgTable(
  "onboarding_sessions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** in_progress | completed | abandoned. */
    status: text("status").notNull().default("in_progress"),
    role: text("role"),
    /** Tool names the person lives in: Notion, Gmail, Calendly, Excel, … */
    tools: jsonb("tools"),
    priorities: jsonb("priorities"),
    personifiedBrief: text("personified_brief"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // One live onboarding per workspace; a completed or abandoned row does not
    // block a fresh one.
    uniqueIndex("onboarding_sessions_workspace_active_key")
      .on(t.workspaceId)
      .where(sql`archived_at is null and status = 'in_progress'`),
    index("onboarding_sessions_workspace_idx").on(t.workspaceId),
  ],
);
