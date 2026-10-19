import { sql } from "drizzle-orm";
import {
  bigint,
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
 * Binaries live in object storage; this table is the only place Axiom records
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
