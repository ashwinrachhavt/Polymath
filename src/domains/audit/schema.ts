import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  unique,
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

/*
 * The reliability primitives every other domain leans on. Audit and outbox
 * rows are written in the same transaction as the change they describe — a
 * change with no audit row did not happen.
 */

export const actorKind = pgEnum("actor_kind", ["user", "system", "agent"]);
export const outboxStatus = pgEnum("outbox_status", ["pending", "dispatched", "failed", "dead"]);
export const webhookStatus = pgEnum("webhook_status", [
  "received",
  "processing",
  "processed",
  "failed",
  "ignored",
]);

/** Idempotency: key + request hash in, stored response out. */
export const requestReceipts = pgTable(
  "request_receipts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code"),
    response: jsonb("response"),
    ...recorded,
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("request_receipts_workspace_key").on(t.workspaceId, t.idempotencyKey)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    actorId: uuid("actor_id"),
    actorKind: actorKind("actor_kind").notNull().default("user"),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata"),
    ...recorded,
  },
  (t) => [
    index("audit_events_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("audit_events_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Stable publish identity (Q03): a retried enqueue with the same key is a no-op. */
    dispatchKey: text("dispatch_key"),
    /** Short lease, claimed without holding a transaction across provider I/O. */
    leaseOwner: text("lease_owner"),
    /** Generation fence: a completion naming an old token is a stale write. */
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    ...recorded,
  },
  (t) => [
    // Partial index: the queue is the pending rows, not the table.
    index("outbox_events_pending_idx").on(t.availableAt).where(sql`status = 'pending'`),
    uniqueIndex("outbox_events_dispatch_key")
      .on(t.workspaceId, t.topic, t.dispatchKey)
      .where(sql`dispatch_key is not null`),
    index("outbox_events_lease_expiry_idx")
      .on(t.leaseExpiresAt)
      .where(sql`lease_owner is not null and status = 'pending'`),
  ],
);

/*
 * Provider deliveries are verified, then recorded before anything is resolved.
 * A delivery id is unique per provider, so a replay is a no-op rather than a
 * second set of side effects.
 */
export const webhookInbox = pgTable(
  "webhook_inbox",
  {
    id: primaryId(),
    /** Null until the delivery is resolved to a workspace. */
    workspaceId: uuid("workspace_id"),
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    status: webhookStatus("status").notNull().default("received"),
    eventType: text("event_type"),
    payload: jsonb("payload").notNull(),
    error: text("error"),
    ...recorded,
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_inbox_provider_delivery_key").on(t.provider, t.deliveryId),
    index("webhook_inbox_unprocessed_idx").on(t.createdAt).where(sql`status in ('received', 'processing')`),
  ],
);

/*
 * Binaries live in object storage; this table is the only place Polymath records
 * that one exists. `retentionClass` is what the retention job reads — raw mail
 * and webhook bodies are kept on a shorter clock than owned documents.
 */
export const blobObjects = pgTable(
  "blob_objects",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    storageKey: text("storage_key").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    retentionClass: text("retention_class").notNull().default("standard"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("blob_objects_storage_key").on(t.storageKey),
    index("blob_objects_workspace_hash_idx").on(t.workspaceId, t.contentHash),
  ],
);

/*
 * ASH-134 Q04: canonical jobs and attempts. Additive; no request path reads
 * these yet. Claims set a lease and bump `generation`; every completion names
 * the lease token, so a worker that outlived its lease cannot write a result.
 */
export const jobStatuses = ["queued", "running", "succeeded", "failed", "cancelled", "unknown"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: text("kind").notNull(),
    input: jsonb("input").notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    generation: integer("generation").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    dedupeKey: text("dedupe_key"),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    result: jsonb("result"),
    lastError: text("last_error"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    unique("jobs_workspace_id_id_key").on(t.workspaceId, t.id),
    check("jobs_status_check", sql.raw(`status in (${jobStatuses.map((s) => `'${s}'`).join(", ")})`)),
    check("jobs_attempts_check", sql`attempts >= 0 and max_attempts >= 1`),
    uniqueIndex("jobs_dedupe_key").on(t.workspaceId, t.kind, t.dedupeKey).where(sql`dedupe_key is not null`),
    index("jobs_queue_idx").on(t.priority.desc(), t.availableAt).where(sql`status = 'queued'`),
    index("jobs_lease_expiry_idx").on(t.leaseExpiresAt).where(sql`status = 'running'`),
    index("jobs_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    jobId: uuid("job_id").notNull(),
    generation: integer("generation").notNull(),
    worker: text("worker").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome"),
    error: text("error"),
  },
  (t) => [
    foreignKey({
      name: "job_attempts_job_fk",
      columns: [t.workspaceId, t.jobId],
      foreignColumns: [jobs.workspaceId, jobs.id],
    }).onDelete("cascade"),
    check("job_attempts_outcome_check", sql`outcome is null or outcome in ('succeeded', 'failed', 'lease_expired', 'cancelled', 'unknown')`),
    uniqueIndex("job_attempts_generation_key").on(t.jobId, t.generation),
  ],
);
