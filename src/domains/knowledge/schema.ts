import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";
import { blobObjects } from "../audit/schema";

/*
 * Artifacts are the one versioned container: a note, a document, a generated
 * report, a diagram, a memo. Versions are immutable snapshots; the artifact
 * row is the mutable pointer. Nothing overwrites content in place, so "what
 * did it say when I approved it" is always answerable.
 */

export const artifactKind = pgEnum("artifact_kind", [
  "note",
  "document",
  "memo",
  "report",
  "diagram",
  "transcript",
  "other",
]);
export const artifactStatus = pgEnum("artifact_status", [
  "draft",
  "generated",
  "reviewed",
  "published",
  "archived",
]);
export const versionReason = pgEnum("version_reason", [
  "created",
  "edited",
  "generated",
  "imported",
  "restored",
  "extracted",
]);
export const fileStatus = pgEnum("file_status", ["uploaded", "imported", "quarantined"]);
export const extractionStatus = pgEnum("extraction_status", [
  "pending",
  "succeeded",
  "failed",
  "skipped",
]);
export const documentDecision = pgEnum("document_decision", [
  "keep",
  "rename",
  "classify",
  "link",
  "discard",
]);
export const claimStatus = pgEnum("claim_status", [
  "proposed",
  "accepted",
  "rejected",
  "retracted",
]);
export const dossierSourcePolicy = pgEnum("dossier_source_policy", ["bounded", "open"]);
export const dossierQuestionStatus = pgEnum("dossier_question_status", [
  "open",
  "answered",
  "dropped",
]);
export const conceptSense = pgEnum("concept_sense", ["ordinary", "technical", "domain"]);

export const artifacts = pgTable(
  "artifacts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: artifactKind("kind").notNull().default("note"),
    title: text("title").notNull(),
    status: artifactStatus("status").notNull().default("draft"),
    /** The current version. Versions are append-only; this is the pointer. */
    currentVersionId: uuid("current_version_id"),
    tags: jsonb("tags").notNull().default([]),
    /** Provenance for generated work: which run or proposal produced it. */
    producedByRunId: uuid("produced_by_run_id"),
    ...mutable,
  },
  (t) => [index("artifacts_workspace_kind_idx").on(t.workspaceId, t.kind, t.updatedAt)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /** Tiptap/ProseMirror JSON for rich text, or a structured payload. */
    content: jsonb("content").notNull(),
    /** Plain text projection — what full-text search indexes. */
    plainText: text("plain_text"),
    reason: versionReason("reason").notNull().default("edited"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("artifact_versions_number_key").on(t.artifactId, t.versionNumber),
    index("artifact_versions_artifact_idx").on(t.artifactId, t.createdAt),
  ],
);

export const workingDrafts = pgTable(
  "working_drafts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    content: jsonb("content").notNull(),
    /** The version this draft started from, for a clean three-way view. */
    baseVersionId: uuid("base_version_id"),
    ...mutable,
  },
  (t) => [uniqueIndex("working_drafts_artifact_key").on(t.artifactId)],
);

export const recoveryCopies = pgTable(
  "recovery_copies",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    content: jsonb("content").notNull(),
    ...recorded,
  },
  (t) => [index("recovery_copies_artifact_idx").on(t.artifactId, t.createdAt)],
);

export const files = pgTable(
  "files",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobObjects.id, { onDelete: "restrict" }),
    filename: text("filename").notNull(),
    status: fileStatus("status").notNull().default("uploaded"),
    /** Where it came from: "upload" | "drive" | "gmail" | provider name. */
    origin: text("origin").notNull().default("upload"),
    externalAccountId: uuid("external_account_id"),
    providerObjectId: text("provider_object_id"),
    ...mutable,
  },
  (t) => [
    index("files_workspace_created_idx").on(t.workspaceId, t.createdAt),
    uniqueIndex("files_external_key")
      .on(t.externalAccountId, t.providerObjectId)
      .where(sql`provider_object_id is not null`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    mimeType: text("mime_type"),
    pageCount: integer("page_count"),
    ...mutable,
  },
  (t) => [index("documents_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

/*
 * Extraction is versioned by the file's content hash, so re-running an
 * improved extractor creates a new row rather than editing one in place and
 * invalidating every span that pointed at it.
 */
export const documentExtractions = pgTable(
  "document_extractions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    status: extractionStatus("status").notNull().default("pending"),
    text: text("text"),
    /** [{ page, start, end }] — offsets let a search result open the exact evidence. */
    spans: jsonb("spans").notNull().default([]),
    extractor: text("extractor"),
    error: text("error"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("document_extractions_content_key").on(t.documentId, t.contentHash),
    index("document_extractions_pending_idx").on(t.workspaceId, t.status),
  ],
);

export const documentDecisions = pgTable(
  "document_decisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    decision: documentDecision("decision").notNull(),
    /** What the classifier proposed, kept even when overridden. */
    proposed: jsonb("proposed"),
    applied: jsonb("applied"),
    model: text("model"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    ...recorded,
  },
  (t) => [index("document_decisions_document_idx").on(t.documentId, t.decidedAt)],
);

/*
 * A source is a canonical identity plus a version — a URL, a file, a message,
 * a page. Claims cite sources, dossiers bind a set of them, and embeddings are
 * scoped to a source version so retrieval can never cite a moving target.
 */
export const sources = pgTable(
  "sources",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: text("kind").notNull(),
    title: text("title"),
    url: text("url"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    /** Canonical URL plus content hash is the dedupe key for fetched material. */
    contentHash: text("content_hash"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    /** Firecrawl request id or provider equivalent, for reproducing a fetch. */
    providerRequestId: text("provider_request_id"),
    metadata: jsonb("metadata"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("sources_workspace_url_hash_key")
      .on(t.workspaceId, t.url, t.contentHash)
      .where(sql`url is not null and content_hash is not null`),
    index("sources_workspace_kind_idx").on(t.workspaceId, t.kind),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    statement: text("statement").notNull(),
    status: claimStatus("status").notNull().default("proposed"),
    /** The artifact this claim lives in, when it belongs to one. */
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "cascade" }),
    confidence: text("confidence"),
    /** Run or proposal that generated it; null for a hand-written claim. */
    producedByRunId: uuid("produced_by_run_id"),
    ...mutable,
  },
  (t) => [index("claims_workspace_status_idx").on(t.workspaceId, t.status), index("claims_artifact_idx").on(t.artifactId)],
);

export const artifactLinks = pgTable(
  "artifact_links",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    label: text("label"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("artifact_links_edge_key").on(t.artifactId, t.targetType, t.targetId),
    // Backlinks are the reverse read of the same row.
    index("artifact_links_target_idx").on(t.workspaceId, t.targetType, t.targetId),
  ],
);

/*
 * A claim's evidence is a span in a source: the exact passage, not the whole
 * document. Deleting the source cascades the span, which is the honest
 * behaviour — an unsourced claim should not silently survive its source.
 */
export const claimEvidence = pgTable(
  "claim_evidence",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    extractionId: uuid("extraction_id").references(() => documentExtractions.id, {
      onDelete: "set null",
    }),
    quote: text("quote"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    ...recorded,
  },
  (t) => [index("claim_evidence_claim_idx").on(t.claimId)],
);

/*
 * Embeddings are versioned: a new model or chunker writes new rows, and the
 * old ones stay until a re-index finishes. Retrieval filters by workspace and
 * by the source version it is allowed to cite.
 */
export const embeddings = pgTable(
  "embeddings",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    /** The immutable thing this vector describes — a version, not a pointer. */
    sourceVersionId: uuid("source_version_id"),
    chunkIndex: integer("chunk_index").notNull().default(0),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    model: text("model").notNull(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("embeddings_owner_chunk_key").on(t.ownerType, t.ownerId, t.model, t.chunkIndex),
    index("embeddings_workspace_idx").on(t.workspaceId, t.ownerType),
    // Approximate nearest neighbour; tuned for cosine similarity.
    index("embeddings_vector_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/*
 * A dossier is a source-bounded workspace: a research question, the exact
 * source versions admitted to it, and what has been concluded so far. It is
 * distinct from a project (an outcome) and a thesis (an argument) — it can
 * link to either without collapsing into them.
 */
export const dossiers = pgTable(
  "dossiers",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    title: text("title").notNull(),
    researchQuestion: text("research_question"),
    sourcePolicy: dossierSourcePolicy("source_policy").notNull().default("bounded"),
    projectId: uuid("project_id"),
    ...mutable,
  },
  (t) => [index("dossiers_workspace_updated_idx").on(t.workspaceId, t.updatedAt)],
);

export const dossierSources = pgTable(
  "dossier_sources",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    dossierId: uuid("dossier_id")
      .notNull()
      .references(() => dossiers.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** Pinned version: a dossier's boundary does not drift when a page changes. */
    pinnedContentHash: text("pinned_content_hash"),
    note: text("note"),
    ...recorded,
  },
  (t) => [uniqueIndex("dossier_sources_key").on(t.dossierId, t.sourceId)],
);

export const dossierQuestions = pgTable(
  "dossier_questions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    dossierId: uuid("dossier_id")
      .notNull()
      .references(() => dossiers.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    status: dossierQuestionStatus("status").notNull().default("open"),
    answer: text("answer"),
    ...mutable,
  },
  (t) => [index("dossier_questions_open_idx").on(t.dossierId, t.status)],
);

/** Dictionary entries: a term, the sense it is being used in, and where it came from. */
export const concepts = pgTable(
  "concepts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    term: text("term").notNull(),
    sense: conceptSense("sense").notNull().default("ordinary"),
    domain: text("domain"),
    definition: text("definition"),
    /** The passage this definition was drawn from, if any. */
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    sourceQuote: text("source_quote"),
    annotation: text("annotation"),
    ...mutable,
  },
  (t) => [uniqueIndex("concepts_workspace_term_sense_key").on(t.workspaceId, t.term, t.sense)],
);

/*
 * Canvas payloads are artifacts with a scene graph. The scene is versioned
 * like any other content, and AI edits arrive as proposals rather than as a
 * silent rewrite of the drawing.
 */
export const canvases = pgTable(
  "canvases",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    ...mutable,
  },
  (t) => [index("canvases_workspace_updated_idx").on(t.workspaceId, t.updatedAt)],
);

export const canvasVersions = pgTable(
  "canvas_versions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /** Excalidraw scene JSON. */
    scene: jsonb("scene").notNull(),
    /** [{ elementId, targetType, targetId }] — shapes that point at real records. */
    elementLinks: jsonb("element_links").notNull().default([]),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("canvas_versions_number_key").on(t.canvasId, t.versionNumber)],
);
