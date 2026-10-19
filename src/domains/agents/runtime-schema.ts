import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId, recorded, recordedBy, tenantId } from "../../db/columns";
import { agentProfiles, agentRuns } from "./schema";

/*
 * Durable runtime bindings (ASH-117, refining ASH-105; migration 0150 is the
 * source of truth for constraints and triggers). Every reference carries
 * workspace_id in a composite foreign key, because a workspace column alone
 * isolates nothing. Schema ownership, indexes, retention and the
 * immutable-versus-mutable split are documented in README.md.
 *
 * Visible redacted summaries only: no secrets, no hidden chain-of-thought.
 */

export const dispatchStates = [
  "planned", // row exists, provider not contacted
  "dispatching", // intent recorded, provider call may or may not have happened
  "dispatched", // provider execution id bound
  "unknown", // call made, outcome not known: reconcile, never guess
  "rejected", // provider definitively refused: nothing started
  "completed",
  "failed",
] as const;
export type DispatchState = (typeof dispatchStates)[number];

export const signalStatuses = ["pending", "sending", "delivered", "failed", "unknown"] as const;
export type SignalStatus = (typeof signalStatuses)[number];

export const invocationStates = ["requested", "in_flight", "succeeded", "failed", "unknown"] as const;
export type InvocationState = (typeof invocationStates)[number];

export const effectClasses = ["read", "internal_write", "external_effect", "paid"] as const;
export type EffectClass = (typeof effectClasses)[number];

/** Append-only: a profile edit makes a new revision; an existing one never changes. */
export const agentProfileRevisions = pgTable(
  "agent_profile_revisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    agentProfileId: uuid("agent_profile_id").notNull(),
    revision: integer("revision").notNull(),
    /** sha256 of the canonical snapshot; identical content reuses a revision. */
    contentHash: text("content_hash").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    ...recordedBy,
  },
  (t) => [
    foreignKey({
      name: "agent_profile_revisions_profile_fk",
      columns: [t.workspaceId, t.agentProfileId],
      foreignColumns: [agentProfiles.workspaceId, agentProfiles.id],
    }).onDelete("cascade"),
    unique("agent_profile_revisions_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("agent_profile_revisions_profile_revision_key").on(t.agentProfileId, t.revision),
    unique("agent_profile_revisions_profile_hash_key").on(t.agentProfileId, t.contentHash),
  ],
);

export const runtimeExecutions = pgTable(
  "runtime_executions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id").notNull(),
    generation: integer("generation").notNull(),
    provider: text("provider").notNull(),
    environment: text("environment").notNull(),
    /** Null until the provider answers; bound exactly once. */
    providerExecutionId: text("provider_execution_id"),
    workflowVersion: text("workflow_version").notNull(),
    /** Stable per logical dispatch, so a retried dispatch cannot start a second execution. */
    dispatchKey: text("dispatch_key").notNull(),
    dispatchState: text("dispatch_state").$type<DispatchState>().notNull().default("planned"),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    uncertainSince: timestamp("uncertain_since", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    redactedError: text("redacted_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    foreignKey({
      name: "runtime_executions_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [agentRuns.workspaceId, agentRuns.id],
    }).onDelete("cascade"),
    unique("runtime_executions_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("runtime_executions_run_generation_key").on(t.runId, t.generation),
    unique("runtime_executions_dispatch_key_key").on(t.workspaceId, t.dispatchKey),
    uniqueIndex("runtime_executions_provider_identity_key")
      .on(t.workspaceId, t.provider, t.environment, t.providerExecutionId)
      .where(sql`provider_execution_id is not null`),
    index("runtime_executions_open_idx")
      .on(t.workspaceId, t.dispatchState)
      .where(sql`dispatch_state in ('dispatching', 'unknown')`),
  ],
);

export const runtimeSignals = pgTable(
  "runtime_signals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    executionId: uuid("execution_id").notNull(),
    /** Caller-stable identity: the same logical signal always carries the same key. */
    signalKey: text("signal_key").notNull(),
    signalType: text("signal_type").notNull(),
    payloadRevision: integer("payload_revision").notNull().default(1),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").$type<SignalStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconcileNote: text("reconcile_note"),
    redactedError: text("redacted_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "runtime_signals_execution_fk",
      columns: [t.workspaceId, t.executionId],
      foreignColumns: [runtimeExecutions.workspaceId, runtimeExecutions.id],
    }).onDelete("cascade"),
    unique("runtime_signals_identity_key").on(t.executionId, t.signalKey),
    index("runtime_signals_open_idx")
      .on(t.workspaceId, t.status)
      .where(sql`status in ('pending', 'sending', 'unknown')`),
  ],
);

export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    runId: uuid("run_id").notNull(),
    executionId: uuid("execution_id"),
    /** Request identity chosen by the caller; reuse with other arguments is an error. */
    invocationId: text("invocation_id").notNull(),
    toolName: text("tool_name").notNull(),
    accountAlias: text("account_alias"),
    effectClass: text("effect_class").$type<EffectClass>().notNull().default("read"),
    argumentsHash: text("arguments_hash").notNull(),
    redactedArguments: jsonb("redacted_arguments"),
    redactedResult: jsonb("redacted_result"),
    state: text("state").$type<InvocationState>().notNull().default("requested"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...recorded,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "tool_invocations_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [agentRuns.workspaceId, agentRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "tool_invocations_execution_fk",
      columns: [t.workspaceId, t.executionId],
      foreignColumns: [runtimeExecutions.workspaceId, runtimeExecutions.id],
    }),
    unique("tool_invocations_identity_key").on(t.runId, t.invocationId),
    index("tool_invocations_unsettled_idx")
      .on(t.workspaceId, t.state)
      .where(sql`state in ('in_flight', 'unknown')`),
  ],
);
