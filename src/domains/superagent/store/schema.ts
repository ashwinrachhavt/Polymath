/**
 * Superagent store: durable rows for the core domain's aggregates and queues.
 *
 * The core (`../core`) owns the model and the rules; this module persists what
 * its repositories read back. Every table is workspace-scoped through the shared
 * tenant boundary, keyed by the domain's own string ids (32-hex `key()` output),
 * so rows and aggregates share one identity.
 *
 * Mapping rules, applied uniformly (see mapping.ts):
 * - The engine's timestamps are ISO strings; columns are timestamptz so SQL can
 *   do time math (claim scans, expiry) without text comparison.
 * - Nested domain documents (threads, actors, mandates, bases, inputs, reports)
 *   are jsonb typed against the core model; Postgres never interprets them.
 * - Aggregates carry an inline `version` column; the flush writes them through a
 *   compare-and-set upsert, so a lost advisory lock fails loudly instead of
 *   silently clobbering (row-state: "versioned").
 * - Runs and subscriptions are normalized out of their parent documents — they
 *   are the parts dispatch passes and fan-out queries scan — and are folded back
 *   into the aggregate on read.
 *
 * Generated columns reference sibling columns unqualified: Postgres requires it
 * for STORED expressions, so the `sql` templates below must not interpolate
 * column builders (which render table-qualified).
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type {
  AcceptMode,
  ActorRef,
  Assessment,
  Attention,
  ChannelRef,
  Execution,
  Follow,
  Mandate,
  MandateBasis,
  ReportState,
  ThreadFacts,
  ThreadRef,
  TicketInput,
  TriggerDisposition,
} from "../core/model";
import type { Reason } from "../core/reasons";
import { primaryId, tenantId } from "../../../db/columns";

/** (workspace_id, id) primary key — every tenanted read is by workspace first. */
const domainPk = (t: { workspaceId: AnyPgColumn; id: AnyPgColumn }) => primaryKey({ columns: [t.workspaceId, t.id] });

/** Configured rule a candidate's text is assessed against; the Policy document owns it. */
export interface PolicyRuleRow {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
  position: number;
}

/** One Source's receiving-scope configuration, keyed by Source id; the core never interprets it. */
export interface PolicySourcePart {
  /** Senders allowed to start explicit work; an empty list allows no one. */
  allowed?: { id: string; name?: string }[];
  /** Bot senders, whose messages are inferred candidates at most. */
  bots?: string[];
  /** The receiving scope's admission row, cell by cell. */
  admission?: Record<
    string,
    Partial<Record<"listedUnaddressed" | "unlistedAddressed" | "unlistedUnaddressed", AcceptMode>>
  >;
  /** Follow for context, or sync chat history. */
  syncChat?: string;
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

/** Immutable Source event; saved once, later annotated with its disposition. */
export const workTriggers = pgTable(
  "work_triggers",
  {
    workspaceId: tenantId(),
    id: text("id").notNull(),
    source: text("source").notNull(),
    threads: jsonb("threads").$type<ThreadRef[]>().notNull(),
    actor: jsonb("actor").$type<ActorRef>().notNull(),
    human: boolean("human").notNull(),
    addressed: text("addressed"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    text: text("text").notNull(),
    channel: jsonb("channel").$type<ChannelRef>(),
    url: text("url"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    disposition: jsonb("disposition").$type<TriggerDisposition>(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    domainPk(t),
    check("work_triggers_addressed_check", sql`${t.addressed} is null or ${t.addressed} in ('mention', 'direct')`),
    index("work_triggers_workspace_at_idx").on(t.workspaceId, t.at),
  ],
);

/* ------------------------------------------------------------------ */
/* WorkThreads and their subscription projection                       */
/* ------------------------------------------------------------------ */

/** WorkThread aggregate; `evaluating` mirrors the in-flight Assessment, subscriptions normalize below. */
export const workThreads = pgTable(
  "work_threads",
  {
    workspaceId: tenantId(),
    key: text("key").notNull(),
    ref: jsonb("ref").$type<ThreadRef>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }),
    correlated: jsonb("correlated").$type<string[]>().notNull().default([]),
    pending: jsonb("pending").$type<string[]>().notNull().default([]),
    evaluating: jsonb("evaluating").$type<Assessment>(),
    expired: integer("expired"),
    meta: jsonb("meta")
      .$type<Record<string, unknown> & { label?: string; facts?: ThreadFacts }>()
      .notNull()
      .default({}),
    /** Maintained by Postgres: a thread is live for dispatch passes while it buffers or evaluates work. */
    isActive: boolean("is_active")
      .notNull()
      .generatedAlwaysAs(sql`jsonb_array_length(pending) > 0 or evaluating is not null`),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.key] }),
    index("work_threads_active_idx")
      .on(t.workspaceId)
      .where(sql`${t.isActive}`),
  ],
);

/* ------------------------------------------------------------------ */
/* Assessments (mirror of thread.evaluating, for the assessor's scans) */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `WorkThread.evaluating` plus its lifecycle: delivered_at/paused_at/
 * ended_at are SQL-side bookkeeping for what the core keeps as `delivered`/
 * `pausedAt` and as the field's disappearance. Never the domain's source of
 * truth — the thread document is — but the assessor's expiry scans read this
 * table, not every thread.
 */
export const workAssessments = pgTable(
  "work_assessments",
  {
    workspaceId: tenantId(),
    id: text("id").notNull(),
    threadKey: text("thread_key").notNull(),
    triggerIds: jsonb("trigger_ids").$type<string[]>().notNull(),
    primaryTriggerId: text("primary_trigger_id"),
    strength: text("strength").notNull(),
    actor: jsonb("actor").$type<ActorRef>().notNull(),
    basis: jsonb("basis").$type<MandateBasis>().notNull(),
    policyVersion: text("policy_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    domainPk(t),
    check("work_assessments_strength_check", sql`${t.strength} in ('explicit', 'inferred')`),
    foreignKey({
      name: "work_assessments_thread_fk",
      columns: [t.workspaceId, t.threadKey],
      foreignColumns: [workThreads.workspaceId, workThreads.key],
    }).onDelete("cascade"),
    index("work_assessments_open_idx")
      .on(t.workspaceId, t.deadline)
      .where(sql`${t.endedAt} is null`),
  ],
);

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

/** Recorded outcome of one eval; tickets reference the accept, threads replay the history. */
export const workDecisions = pgTable(
  "work_decisions",
  {
    workspaceId: tenantId(),
    id: text("id").notNull(),
    assessmentId: text("assessment_id").notNull(),
    threadKey: text("thread_key").notNull(),
    triggerIds: jsonb("trigger_ids").$type<string[]>().notNull(),
    policyVersion: text("policy_version").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    reason: jsonb("reason").$type<Reason[]>().notNull(),
    strength: text("strength").notNull(),
    ticketId: text("ticket_id"),
    mandate: jsonb("mandate").$type<Mandate>(),
    audit: jsonb("audit").$type<Record<string, unknown>>(),
    dismissed: boolean("dismissed").notNull().default(false),
    /** Insertion order across commands, for stable history reads. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    domainPk(t),
    check("work_decisions_kind_check", sql`${t.kind} in ('ignore', 'accept', 'reopen', 'stop', 'unavailable')`),
    check("work_decisions_strength_check", sql`${t.strength} in ('explicit', 'inferred')`),
    foreignKey({
      name: "work_decisions_thread_fk",
      columns: [t.workspaceId, t.threadKey],
      foreignColumns: [workThreads.workspaceId, workThreads.key],
    }).onDelete("cascade"),
    index("work_decisions_thread_idx").on(t.workspaceId, t.threadKey, t.seq),
  ],
);

/* ------------------------------------------------------------------ */
/* Tickets and their runs                                              */
/* ------------------------------------------------------------------ */

/**
 * Ticket aggregate. `runs` live in ticket_runs (they are what dispatch passes
 * count); inputs stay embedded — they are the ticket's own append log and the
 * core reads them as a whole. End state is flattened to columns so "ended" is
 * filterable without a jsonb traversal.
 */
export const workTickets = pgTable(
  "work_tickets",
  {
    workspaceId: tenantId(),
    id: text("id").notNull(),
    title: text("title").notNull(),
    decisionId: text("decision_id").notNull(),
    mandate: jsonb("mandate").$type<Mandate>().notNull(),
    channels: jsonb("channels").$type<ChannelRef[]>().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    endedOutcome: text("ended_outcome"),
    endedReason: text("ended_reason"),
    attention: jsonb("attention").$type<Attention>(),
    inputs: jsonb("inputs").$type<TicketInput[]>().notNull().default([]),
    undelivered: jsonb("undelivered").$type<string[]>().notNull().default([]),
    follows: jsonb("follows").$type<Follow[]>(),
    answers: jsonb("answers").$type<string[]>(),
    origin: jsonb("origin").$type<{ triggerId: string; triggerIds: string[] }>().notNull(),
    execution: jsonb("execution").$type<Execution>(),
    delivery: jsonb("delivery").$type<{ error: string; at: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    /** Maintained by the flush: the state of the ticket's latest run, feeding the active filter below. */
    latestRunState: text("latest_run_state"),
    /** Maintained by Postgres: undelivered input, or a run that can still receive one, on an unended ticket. */
    isActive: boolean("is_active")
      .notNull()
      .generatedAlwaysAs(
        // Null-proof: a null latest_run_state must make the ticket inactive,
        // not make the generated column itself null.
        sql`ended_at is null and (jsonb_array_length(undelivered) > 0 or (latest_run_state is not null and latest_run_state in ('pending', 'running')))`,
      ),
    /** Insertion order across commands, for stable "newest first" reads. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    domainPk(t),
    check("work_tickets_ended_by_check", sql`${t.endedBy} is null or ${t.endedBy} in ('executor', 'human')`),
    check(
      "work_tickets_ended_outcome_check",
      sql`${t.endedOutcome} is null or ${t.endedOutcome} in ('completed', 'merged', 'closed', 'dropped', 'stopped')`,
    ),
    check(
      "work_tickets_latest_run_state_check",
      sql`${t.latestRunState} is null or ${t.latestRunState} in ('pending', 'running', 'ended')`,
    ),
    index("work_tickets_active_idx")
      .on(t.workspaceId)
      .where(sql`${t.isActive}`),
    index("work_tickets_open_idx")
      .on(t.workspaceId, t.seq)
      .where(sql`${t.endedAt} is null`),
  ],
);

/** Binding between a ticket and one executor instance; appended and state-machined by the engine. */
export const ticketRuns = pgTable(
  "ticket_runs",
  {
    workspaceId: tenantId(),
    id: text("id").notNull(),
    ticketId: text("ticket_id").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    report: jsonb("report").$type<{ state: ReportState; summary: string; at: string }>(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    idleAt: timestamp("idle_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => [
    domainPk(t),
    check("ticket_runs_state_check", sql`${t.state} in ('pending', 'running', 'ended')`),
    foreignKey({
      name: "ticket_runs_ticket_fk",
      columns: [t.workspaceId, t.ticketId],
      foreignColumns: [workTickets.workspaceId, workTickets.id],
    }).onDelete("cascade"),
    index("ticket_runs_ticket_idx").on(t.workspaceId, t.ticketId, t.seq),
    index("ticket_runs_open_idx")
      .on(t.workspaceId, t.state)
      .where(sql`${t.state} <> 'ended'`),
  ],
);

/**
 * Projection of `WorkThread.subscriptions` and `WorkThread.context` — one row
 * per (thread, ticket, kind). The engine owns the arrays on the aggregate; this
 * table makes "which tickets receive this thread's triggers" a join instead of a
 * scan of every thread document, and cascades so projections cannot outlive
 * either side.
 */
export const workSubscriptions = pgTable(
  "work_subscriptions",
  {
    workspaceId: tenantId(),
    threadKey: text("thread_key").notNull(),
    ticketId: text("ticket_id").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.threadKey, t.ticketId, t.kind] }),
    check("work_subscriptions_kind_check", sql`${t.kind} in ('subscription', 'context')`),
    foreignKey({
      name: "work_subscriptions_thread_fk",
      columns: [t.workspaceId, t.threadKey],
      foreignColumns: [workThreads.workspaceId, workThreads.key],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_subscriptions_ticket_fk",
      columns: [t.workspaceId, t.ticketId],
      foreignColumns: [workTickets.workspaceId, workTickets.id],
    }).onDelete("cascade"),
  ],
);

/* ------------------------------------------------------------------ */
/* Effects: the durable work queue                                     */
/* ------------------------------------------------------------------ */

/** Domain work the engine asks the host to perform after commit; `key` names the unit. */
export type EffectKind = "assessment" | "launch" | "delivery" | "relay" | "notice" | "reply";

/**
 * One row per kind+key while pending: the unique partial index coalesces bursts
 * (the same launch effect enqueued twice in one command inserts once), claims
 * lease rows to a worker, and failures schedule the next attempt with backoff.
 * Three consecutive failures raise `needsAttention` — a health entry, not a dead
 * letter: effects retry at the cap until a person intervenes.
 */
export const workEffects = pgTable(
  "work_effects",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    needsAttention: boolean("needs_attention")
      .notNull()
      .generatedAlwaysAs(sql`consecutive_failures >= 3`),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "work_effects_kind_check",
      sql`${t.kind} in ('assessment', 'launch', 'delivery', 'relay', 'notice', 'reply')`,
    ),
    check("work_effects_status_check", sql`${t.status} in ('pending', 'done')`),
    index("work_effects_dispatch_idx").on(t.workspaceId, t.status, t.availableAt),
    uniqueIndex("work_effects_pending_key_idx")
      .on(t.workspaceId, t.kind, t.key)
      .where(sql`${t.status} = 'pending'`),
    index("work_effects_attention_idx")
      .on(t.workspaceId)
      .where(sql`${t.needsAttention}`),
  ],
);

/* ------------------------------------------------------------------ */
/* Outbound receipts: the reply lane's send-once log                   */
/* ------------------------------------------------------------------ */

/** An outbound message queued for a channel; the primary key is the send-once guarantee. */
export const workOutboxReceipts = pgTable(
  "work_outbox_receipts",
  {
    workspaceId: tenantId(),
    id: text("id").notNull(),
    channel: jsonb("channel").$type<ChannelRef>().notNull(),
    text: text("text").notNull(),
    kind: text("kind").notNull(),
    ticketId: text("ticket_id"),
    status: text("status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Insertion order across commands: per-conversation delivery reads it in seq order. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => [
    domainPk(t),
    check("work_outbox_receipts_kind_check", sql`${t.kind} in ('acknowledgement', 'reply', 'notice')`),
    check("work_outbox_receipts_status_check", sql`${t.status} in ('pending', 'sent', 'dropped')`),
    foreignKey({
      name: "work_outbox_receipts_ticket_fk",
      columns: [t.workspaceId, t.ticketId],
      foreignColumns: [workTickets.workspaceId, workTickets.id],
    }).onDelete("cascade"),
    index("work_outbox_receipts_pending_idx")
      .on(t.workspaceId, t.seq)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/* ------------------------------------------------------------------ */
/* Policy: settings-versioned gate configuration                       */
/* ------------------------------------------------------------------ */

/** The workspace's Policy document: one row per workspace, version-hashed on save. */
export const superagentPolicies = pgTable(
  "superagent_policies",
  {
    workspaceId: tenantId(),
    version: text("version").notNull(),
    paused: boolean("paused").notNull().default(false),
    acceptMode: text("accept_mode").notNull().default("off"),
    evalTimeoutMs: integer("eval_timeout_ms").notNull(),
    sources: jsonb("sources").$type<Record<string, PolicySourcePart>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId] }),
    check("superagent_policies_accept_mode_check", sql`${t.acceptMode} in ('off', 'observe', 'auto')`),
    check("superagent_policies_eval_timeout_check", sql`${t.evalTimeoutMs} > 0`),
  ],
);

/** Configured rules; rows are replaced wholesale on each policy save, so a row is written once. */
export const superagentPolicyRules = pgTable(
  "superagent_policy_rules",
  {
    workspaceId: tenantId(),
    ruleId: text("rule_id").notNull(),
    name: text("name").notNull(),
    instruction: text("instruction").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.ruleId] }),
    foreignKey({
      name: "superagent_policy_rules_policy_fk",
      columns: [t.workspaceId],
      foreignColumns: [superagentPolicies.workspaceId],
    }).onDelete("cascade"),
    index("superagent_policy_rules_position_idx").on(t.workspaceId, t.position),
  ],
);

export type WorkTriggerRow = typeof workTriggers.$inferSelect;
export type WorkThreadRow = typeof workThreads.$inferSelect;
export type WorkSubscriptionRow = typeof workSubscriptions.$inferSelect;
export type WorkAssessmentRow = typeof workAssessments.$inferSelect;
export type WorkDecisionRow = typeof workDecisions.$inferSelect;
export type WorkTicketRow = typeof workTickets.$inferSelect;
export type TicketRunRow = typeof ticketRuns.$inferSelect;
export type WorkEffectRow = typeof workEffects.$inferSelect;
export type WorkOutboxReceiptRow = typeof workOutboxReceipts.$inferSelect;
export type SuperagentPolicyRow = typeof superagentPolicies.$inferSelect;
export type SuperagentPolicyRuleRow = typeof superagentPolicyRules.$inferSelect;
