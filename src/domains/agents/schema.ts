import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
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
 * Dispatch moves through these states in order, but `uncertain` is a state,
 * not an error: a timeout between dispatch and bind means the execution may
 * exist at the provider, and only reconciliation can close it.
 */
export const dispatchState = pgEnum("dispatch_state", [
  "pending",
  "dispatched",
  "bound",
  "uncertain",
  "completed",
  "failed",
]);
export const signalStatus = pgEnum("signal_status", ["pending", "delivered", "failed", "unknown"]);
export const signalReconciliation = pgEnum("signal_reconciliation", [
  "not_needed",
  "pending",
  "resolved",
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
    isDefault: boolean("is_default").notNull().default(false),
    ...mutable,
  },
  (t) => [
    uniqueIndex("agent_profiles_workspace_name_key").on(t.workspaceId, t.name),
    // Enables tenant-composite foreign keys on runtime tables: a profile
    // revision in workspace A can never point at a profile in workspace B.
    uniqueIndex("agent_profiles_workspace_id_key").on(t.workspaceId, t.id),
  ],
);

/*
 * A profile row is mutable; a run is not. Each revision is the immutable copy
 * of the profile exactly as admitted, and a run points at the revision it was
 * started with. Editing the profile later writes a new revision; the old one
 * — and every run bound to it — is untouched. Revisions are append-only
 * (`recordedBy`), never updated.
 */
export const agentProfileRevisions = pgTable(
  "agent_profile_revisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions"),
    modelPolicy: jsonb("model_policy").notNull().default({}),
    allowedTools: jsonb("allowed_tools").notNull().default([]),
    allowedAccounts: jsonb("allowed_accounts").notNull().default([]),
    contextPolicy: jsonb("context_policy").notNull().default({}),
    budgetPolicy: jsonb("budget_policy").notNull().default({}),
    memoryPolicy: jsonb("memory_policy").notNull().default({}),
    ...recordedBy,
  },
  (t) => [
    uniqueIndex("agent_profile_revisions_number_key").on(t.profileId, t.revisionNumber),
    index("agent_profile_revisions_workspace_idx").on(t.workspaceId, t.createdAt),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [agentProfiles.workspaceId, agentProfiles.id],
    }),
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
    /**
     * The immutable profile revision this run was admitted with. Null on runs
     * started before revisions existed; their frozen policySnapshot is the
     * same guarantee in coarser form.
     */
    profileRevisionId: uuid("profile_revision_id").references(() => agentProfileRevisions.id, {
      onDelete: "restrict",
    }),
    /** Retries create a new run pointing at the one they replace. */
    retryOfRunId: uuid("retry_of_run_id"),
    objective: text("objective").notNull(),
    /** Record references the objective may touch. */
    subjects: jsonb("subjects").notNull().default([]),
    state: runState("state").notNull().default("queued"),
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
    ...mutable,
  },
  (t) => [
    index("agent_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // Tenant-composite key for runtime tables: an execution or signal row can
    // never reference a run outside its own workspace.
    uniqueIndex("agent_runs_workspace_id_key").on(t.workspaceId, t.id),
    // Partial index: the live queue is the non-terminal rows.
    index("agent_runs_active_idx").on(t.workspaceId, t.state).where(sql`state in ('queued', 'running', 'waiting_input', 'waiting_approval')`),
    index("agent_runs_thread_idx").on(t.threadId),
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
    /**
     * Caller's durable request identity for this invocation. Replaying a
     * request with the same identity returns the recorded row instead of
     * repeating paid work or an external effect; the same identity with
     * different arguments is rejected (see recordToolInvocation).
     */
    invocationId: text("invocation_id"),
    /** Canonical hash of the redacted arguments: stable key order, no whitespace. */
    argumentHash: text("argument_hash"),
    /** requested | in_flight | completed | failed | unknown. Null on legacy rows. */
    executionState: text("execution_state"),
    ...recorded,
  },
  (t) => [
    index("tool_calls_run_idx").on(t.runId, t.createdAt),
    // One logical invocation per workspace; a replay matches, never duplicates.
    uniqueIndex("tool_calls_invocation_key")
      .on(t.workspaceId, t.invocationId)
      .where(sql`invocation_id is not null`),
  ],
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
    ...recorded,
  },
  (t) => [uniqueIndex("run_events_run_sequence_key").on(t.runId, t.sequence)],
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
 * One row per logical execution of a run at a provider. A retry writes a new
 * generation; the provider's own execution id is bound when known and unique
 * per (provider, environment), so two Axiom runs can never both claim the
 * same provider-side execution. `uncertain` covers the window where a
 * dispatch timed out: the execution may exist, and it is neither failed nor
 * succeeded until reconciliation closes it.
 */
export const runExecutions = pgTable(
  "run_executions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** 1 for the first dispatch; each retry increments it. */
    generation: integer("generation").notNull(),
    provider: text("provider").notNull(),
    /** production | staging | preview — the same provider id means different things across environments. */
    environment: text("environment").notNull().default("production"),
    providerExecutionId: text("provider_execution_id"),
    workflowVersion: text("workflow_version"),
    /** Idempotency key chosen at dispatch; stable across retries of the same logical work. */
    dispatchKey: text("dispatch_key"),
    state: dispatchState("state").notNull().default("pending"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    /** When the execution became unresolvable by state alone — the reconciliation clock starts here. */
    uncertainAt: timestamp("uncertain_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...recorded,
  },
  (t) => [
    uniqueIndex("run_executions_generation_key").on(t.runId, t.generation),
    uniqueIndex("run_executions_provider_execution_key")
      .on(t.provider, t.environment, t.providerExecutionId)
      .where(sql`provider_execution_id is not null`),
    uniqueIndex("run_executions_dispatch_key_key")
      .on(t.workspaceId, t.dispatchKey)
      .where(sql`dispatch_key is not null`),
    // The reconciliation sweep: executions that may exist but are not provably closed.
    index("run_executions_uncertain_idx")
      .on(t.workspaceId, t.uncertainAt)
      .where(sql`state = 'uncertain'`),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [agentRuns.workspaceId, agentRuns.id],
    }),
  ],
);

/*
 * A signal (cancel, answer, resume, steering input) is durable before it is
 * delivered: the row is the delivery record, with a stable identity, the hash
 * of the payload actually sent, and an attempt count. `unknown` means a
 * delivery attempt's outcome was lost; reconciliation must resolve it before
 * the signal is sent again, because a retried signal can arrive twice.
 */
export const runSignals = pgTable(
  "run_signals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id").references(() => runExecutions.id, { onDelete: "set null" }),
    /** The execution generation this signal targets; a stale generation's signal is rejected by the domain. */
    generation: integer("generation").notNull(),
    /** Durable delivery identity, e.g. "cancel" or "answer:<questionId>". */
    signalKey: text("signal_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /** Redacted payload summary, never secrets or raw provider payloads. */
    payloadSummary: jsonb("payload_summary"),
    status: signalStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    reconciliation: signalReconciliation("reconciliation").notNull().default("not_needed"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("run_signals_delivery_key").on(t.runId, t.generation, t.signalKey),
    index("run_signals_pending_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`status in ('pending', 'unknown')`),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [agentRuns.workspaceId, agentRuns.id],
    }),
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
