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
  (t) => [uniqueIndex("agent_profiles_workspace_name_key").on(t.workspaceId, t.name)],
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
    createdBy: uuid("created_by"),
    ...recorded,
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
    /** Frozen at start: profile, model, tools, accounts, budget, policy. */
    policySnapshot: jsonb("policy_snapshot").notNull(),
    model: text("model"),
    summary: text("summary"),
    /** Redacted failure detail. Never a raw provider payload. */
    error: text("error"),
    /** Highest event sequence written, for SSE reconnect. */
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    index("agent_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // Partial index: the live queue is the non-terminal rows.
    index("agent_runs_active_idx").on(t.workspaceId, t.state).where(sqlActive()),
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
  (t) => [uniqueIndex("run_artifacts_key").on(t.runId, t.artifactId)],
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

function sqlActive() {
  return sql`state in ('queued', 'running', 'waiting_input', 'waiting_approval')`;
}
