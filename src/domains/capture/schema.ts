import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";
import { blobObjects } from "../audit/schema";
import { documents } from "../knowledge/schema";

/*
 * Capture is deliberately dumb: whatever arrived, exactly as it arrived, plus
 * a processing state. Everything derived from it is a proposal or a converted
 * record that points back here, so the original survives every later edit.
 */

export const captureKind = pgEnum("capture_kind", ["text", "url", "file", "voice", "forwarded"]);
/*
 * How the text arrived, which decides what "the same capture" means. A
 * selection or a page grab is one reading of a URL and many may exist; a
 * url-reference is the URL itself, so it may exist only once.
 */
export const captureMode = pgEnum("capture_mode", ["authored", "selection", "page", "url-reference", "blob"]);
export const captureFetchOutcome = pgEnum("capture_fetch_outcome", [
  "pending",
  "acquired",
  "error-page",
  "access-denied",
  "empty",
  "provider-unavailable",
]);
export const captureSource = pgEnum("capture_source", [
  "quick_capture",
  "email",
  "webhook",
  "companion",
  "import",
  "api",
]);
export const captureProcessingState = pgEnum("capture_processing_state", [
  "unprocessed",
  "classifying",
  "enriched",
  "converted",
  "discarded",
  "failed",
]);

export const captures = pgTable(
  "captures",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: captureKind("kind").notNull(),
    source: captureSource("source").notNull().default("quick_capture"),
    /** The original, immutable. Text bodies, pasted URLs, and transcripts live here. */
    rawPayload: jsonb("raw_payload").notNull(),
    text: text("text"),
    url: text("url"),
    /**
     * The command always supplies this and the 0258 backfill filled history, so
     * there is no default: a row that arrives without a mode is a bug, not a
     * silently-authored capture.
     */
    captureMode: captureMode("capture_mode").notNull(),
    /** The server's reading of the URL, kept apart from what the person sent. */
    fetchedText: text("fetched_text"),
    /** sha256 of the arriving text; null for blob and url-reference. */
    contentHash: text("content_hash"),
    /** Null until a fetch is attempted. */
    fetchOutcome: captureFetchOutcome("fetch_outcome"),
    blobId: uuid("blob_id").references(() => blobObjects.id, { onDelete: "set null" }),
    processingState: captureProcessingState("processing_state").notNull().default("unprocessed"),
    /** Suggested by enrichment; never overwrites a person-supplied title. */
    title: text("title"),
    /** Tier 0 output: normalized text. raw_payload stays the immutable original. */
    cleanText: text("clean_text"),
    /** Tier 1 verdict from regex heuristics: prose, code, list, url, log, contact. */
    structure: text("structure"),
    /** Tier 2 LLM reading: one of the capture domains (see classification.ts). */
    domain: text("domain"),
    /** Tier 2 LLM reading: free-form topic tags, capped. */
    tags: jsonb("tags"),
    /**
     * What the capture is (kind-label.ts: article, idea, task, ...), apart from
     * how it arrived (`kind`). Set by the rules, then Jev, or by the person;
     * `kind_source` says which, and a "user" label is never overwritten.
     */
    kindLabel: text("kind_label"),
    /** One plain sentence on why; with no label, why the capture is not classified. */
    kindReason: text("kind_reason"),
    kindSource: text("kind_source"),
    /** Set once the capture becomes a canonical record; the lineage edge. */
    convertedType: text("converted_type"),
    convertedId: uuid("converted_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    /**
     * ASH-305: set aside at end of day. A SEPARATE axis from processing_state on
     * purpose: parking pauses the owner-facing queue and new background work
     * but never rewrites what enrichment or conversion decided, so unparking
     * restores the capture exactly as it was (no re-classification, no
     * duplicate effect). Null = not parked.
     */
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    parkedBy: uuid("parked_by"),
    /**
     * ASH-305: the enrichment run's fenced, time-boxed claim. A run takes it
     * before any provider call; every later write of that run must match the
     * token, so an expired or superseded holder can never write or clear a
     * newer holder's work. Null = nobody enriching.
     */
    enrichmentLeaseToken: uuid("enrichment_lease_token"),
    enrichmentLeaseUntil: timestamp("enrichment_lease_until", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // Partial index: the Inbox queue is the unprocessed rows.
    index("captures_inbox_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`processing_state in ('unprocessed', 'classifying')`),
    // Identity on what actually arrived: one article yields many selections and
    // one page grab, but the identical text twice is the same capture. A bare
    // url-reference is the URL itself and gets its own rule below.
    uniqueIndex("captures_identity_key")
      .on(t.workspaceId, t.source, t.url, t.captureMode, t.contentHash)
      .where(sql`url is not null and capture_mode <> 'url-reference'`),
    uniqueIndex("captures_url_reference_key")
      .on(t.workspaceId, t.source, t.url)
      .where(sql`url is not null and capture_mode = 'url-reference'`),
    // Uniqueness over a nullable column does not dedupe (btree is NULLS
    // DISTINCT), so a caller that forgot the hash would silently switch
    // identity off for that row. The database refuses it.
    check(
      "captures_identity_hash_present",
      sql`url is null or capture_mode in ('url-reference', 'blob') or content_hash is not null`,
    ),
    check(
      "captures_kind_label_known",
      sql`kind_label is null or kind_label in ('article', 'idea', 'task', 'person', 'reference', 'quote', 'other')`,
    ),
    // A label always says who set it, and a source never stands without a label.
    check(
      "captures_kind_source_known",
      sql`(kind_label is null) = (kind_source is null) and (kind_source is null or kind_source in ('rules', 'jev', 'user'))`,
    ),
  ],
);

/*
 * The library documents a link capture brought in: every page of the site its
 * crawl read, root first. A page that was already in the library is linked,
 * not filed twice (documents are unique per URL), so one document may belong
 * to several captures. Deleting either side drops the link only.
 */
export const captureDocuments = pgTable(
  "capture_documents",
  {
    workspaceId: tenantId(),
    captureId: uuid("capture_id")
      .notNull()
      .references(() => captures.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The page's place in the crawl's order, 0 for the address captured. */
    position: integer("position").notNull(),
    ...recorded,
  },
  (t) => [
    primaryKey({ columns: [t.captureId, t.documentId] }),
    index("capture_documents_document_idx").on(t.workspaceId, t.documentId),
  ],
);
