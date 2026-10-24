import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import {
  artifactLinkType,
  artifactLinkTypeCheck,
  linkTargetKind,
  linkTargetKindCheck,
  mutable,
  primaryId,
  recorded,
  recordedBy,
  tenantId,
} from "../../db/columns";
import { blobObjects } from "../audit/schema";
import { users } from "../identity/tables";
import { companies, contacts } from "../crm/schema";

/*
 * Artifacts are the one versioned container: a note, a document, a generated
 * report, a diagram, a memo. Versions are immutable snapshots; the artifact
 * row is the mutable pointer. Nothing overwrites content in place, so "what
 * did it say when I approved it" is always answerable.
 */

export const artifactKind = pgEnum("artifact_kind", [
  "note",
  "zettel",
  "document",
  "memo",
  "report",
  "diagram",
  "transcript",
  "deck",
  "infographic",
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
export const zettelProposalStatus = pgEnum("zettel_proposal_status", ["proposed", "accepted", "rejected"]);
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
    /**
     * Last embedding failure recorded against the CURRENT version: a pass
     * writes it only while its version is still current, and every version
     * commit clears it, so a stale version's failure never mislabels fresh
     * text. Null after a successful pass.
     */
    embedError: text("embed_error"),
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
    ...recordedBy,
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
    /**
     * The one doc-type signal (ASH-143): set by an accepted classification
     * proposal, consumed by obligations and title suggestions - never re-typed
     * by editing the title string.
     */
    docType: text("doc_type").$type<import("./vocabulary").DocumentType | null>(),
    mimeType: text("mime_type"),
    pageCount: integer("page_count"),
    /** Where the bytes came from when the document was captured from a URL; null for an upload. */
    sourceUrl: text("source_url"),
    /*
     * The folder this document is filed in; null is the library root. A
     * document's identity never depends on where it is filed - moving is a
     * folder event, not a new document.
     */
    folderId: uuid("folder_id").references((): AnyPgColumn => documentFolders.id, {
      onDelete: "set null",
    }),
    /*
     * The version the library, review and retrieval treat as current; null
     * means the newest extraction (the default before restores existed). A
     * restore only ever points this at a succeeded row, and a new extraction
     * version clears it, so the pointer can never strand a document on a
     * failed or stale read. Set null if the row is pruned.
     */
    activeExtractionId: uuid("active_extraction_id").references(
      (): AnyPgColumn => documentExtractions.id,
      { onDelete: "set null" },
    ),
    ...mutable,
  },
  (t) => [
    // One document per URL per workspace: pasting a URL twice finds this row.
    uniqueIndex("documents_workspace_source_url_key")
      .on(t.workspaceId, t.sourceUrl)
      .where(sql`source_url is not null`),
    index("documents_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("documents_file_idx").on(t.fileId),
    index("documents_artifact_idx").on(t.artifactId),
    index("documents_folder_idx").on(t.workspaceId, t.folderId),
  ],
);

/*
 * The file-manager tree (Box-feel library). A folder is a name plus a parent;
 * the root is "no folder". Names are unique per folder, case-insensitively,
 * among live folders - the same rule Box applies. Archiving a folder is
 * blocked by the domain while it still holds live documents or subfolders,
 * so nothing is ever silently unfiled.
 */
export const documentFolders = pgTable(
  "document_folders",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Null is a top-level folder. Restrict: a folder with subfolders cannot vanish. */
    parentId: uuid("parent_id").references((): AnyPgColumn => documentFolders.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("document_folders_name_key")
      .on(t.workspaceId, sql`coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(name)`)
      .where(sql`archived_at is null`),
    index("document_folders_parent_idx").on(t.workspaceId, t.parentId),
  ],
);

/*
 * Append-only filing history: which folder a document left and which it
 * entered. The activity feed reads this so "when did this move" is
 * answerable, and a move is never a silent edit.
 */
export const documentFolderEvents = pgTable(
  "document_folder_events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    fromFolderId: uuid("from_folder_id").references((): AnyPgColumn => documentFolders.id, {
      onDelete: "set null",
    }),
    toFolderId: uuid("to_folder_id").references((): AnyPgColumn => documentFolders.id, {
      onDelete: "set null",
    }),
    ...recordedBy,
  },
  (t) => [index("document_folder_events_document_idx").on(t.workspaceId, t.documentId, t.createdAt)],
);

/*
 * Export manifest (ASH-130): a named selection of documents for a party or
 * purpose, each item pinned to the exact extraction version chosen at the
 * time. The pin is the honest core: re-extracting a document later never
 * changes what the manifest says it exported, and the read side reports
 * drift ("a newer version exists") instead of silently upgrading.
 */
export const documentExportManifests = pgTable(
  "document_export_manifests",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    /** What this packet is for, in the owner's words. */
    purpose: text("purpose"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    ...mutable,
  },
  (t) => [index("document_export_manifests_workspace_idx").on(t.workspaceId, t.updatedAt)],
);

/*
 * Free tags on documents (Box-feel organization). Normalized lowercase, one
 * row per (document, tag); tagging is additive and idempotent, untagging
 * removes only the named tag. The shape matches what the Files surface UI
 * was built against.
 */
/*
 * An assembled packet: the immutable zip of one manifest's pinned versions,
 * stored as a blob so a download serves exactly what was assembled, even
 * after the manifest or documents change. `manifest_version` records what
 * was assembled from; a later manifest edit does not mutate past packets.
 */
export const documentExportPackets = pgTable(
  "document_export_packets",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => documentExportManifests.id, { onDelete: "cascade" }),
    manifestVersion: integer("manifest_version").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobObjects.id, { onDelete: "restrict" }),
    itemCount: integer("item_count").notNull(),
    missingCount: integer("missing_count").notNull().default(0),
    driftedCount: integer("drifted_count").notNull().default(0),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    ...recordedBy,
  },
  (t) => [
    index("document_export_packets_manifest_idx").on(t.manifestId, t.createdAt),
    index("document_export_packets_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const documentTags = pgTable(
  "document_tags",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    ...recordedBy,
  },
  (t) => [
    uniqueIndex("document_tags_document_tag_key").on(t.documentId, t.tag),
    check("document_tags_tag_check", sql`tag = lower(btrim(tag)) and length(tag) between 1 and 40`),
    index("document_tags_workspace_tag_idx").on(t.workspaceId, t.tag),
  ],
);

export const documentExportManifestItems = pgTable(
  "document_export_manifest_items",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => documentExportManifests.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /*
     * The pinned version: the latest succeeded extraction when the item was
     * added. The hash is denormalized so the pin survives the extraction
     * row's pruning; null when the document had no succeeded extraction,
     * which the manifest says out loud rather than pretending a version.
     */
    extractionId: uuid("extraction_id").references((): AnyPgColumn => documentExtractions.id, {
      onDelete: "set null",
    }),
    extractionContentHash: text("extraction_content_hash"),
    note: text("note"),
    position: integer("position").notNull().default(0),
    ...recordedBy,
  },
  (t) => [
    uniqueIndex("document_export_manifest_items_document_key").on(t.manifestId, t.documentId),
    index("document_export_manifest_items_manifest_idx").on(t.workspaceId, t.manifestId, t.position),
  ],
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
    /*
     * Table cell grids from the provider, when it reports coordinates. Kept
     * beside the text so a statement can be re-parsed against a better mapper
     * without paying for the conversion again. Null for providers that only
     * return prose.
     */
    tables: jsonb("tables"),
    extractor: text("extractor"),
    error: text("error"),
    /*
     * The proposal pass (fields, parties, obligations) is its own retry
     * boundary: text can be durable evidence while proposals failed or never
     * ran. Null means the pass has not been attempted for this extraction.
     */
    proposalStatus: extractionStatus("proposal_status"),
    /** What proposed the fields, e.g. "text-rules@1" or the provider's own. */
    proposer: text("proposer"),
    proposalError: text("proposal_error"),
    /** When the current proposal claim was taken; a stale pending claim is reclaimable. */
    proposalClaimedAt: timestamp("proposal_claimed_at", { withTimezone: true }),
    /*
     * The extraction lease. A caller claims a row by stamping `claimedAt` and
     * its own `claimedBy` token; only that token may write the result, so a
     * process that outlives its lease cannot overwrite a newer attempt. A
     * pending row whose lease is older than EXTRACTION_LEASE_SECONDS belongs
     * to a dead process and may be reclaimed. Null `claimedAt` is a row from
     * before leases existed; its `createdAt` stands in.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    /*
     * The embedding pass is its own boundary, like the proposal pass: text can
     * be durable evidence while chunks failed to embed. A failure here never
     * touches `status`, and a retry reads `text`, never the file.
     */
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    embedModel: text("embed_model"),
    embedError: text("embed_error"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("document_extractions_content_key").on(t.documentId, t.contentHash),
    index("document_extractions_pending_idx").on(t.workspaceId, t.status),
  ],
);

/*
 * Append-only attempt history for one extraction row. The row above holds the
 * current state; this holds every try, so a retry never erases the error that
 * made it necessary. `outcome` is null while the attempt holds the lease.
 */
export const extractionAttemptOutcome = pgEnum("extraction_attempt_outcome", [
  "succeeded",
  "failed",
  "abandoned",
]);

export const documentExtractionAttempts = pgTable(
  "document_extraction_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => documentExtractions.id, { onDelete: "cascade" }),
    /** 1 for the first claim of the extraction, then one more per retry. */
    attempt: integer("attempt").notNull(),
    claimedBy: text("claimed_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: extractionAttemptOutcome("outcome"),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("document_extraction_attempts_number_key").on(t.extractionId, t.attempt),
    index("document_extraction_attempts_workspace_idx").on(t.workspaceId, t.extractionId),
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
    index("sources_file_idx").on(t.fileId),
  ],
);

/*
 * A video's timed text, kept beside the document rather than inside its spans.
 *
 * Extraction spans are character offsets into the text (page, start, end), and
 * chunking compares them to character positions. A video timestamp is seconds
 * into the media, which is a different coordinate. Overloading one for the
 * other makes every citation point at the wrong passage, so the cue table lives
 * here and a citation deep-links to `?t=<seconds>` from it.
 */
export const youtubeTranscripts = pgTable(
  "youtube_transcripts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The canonical youtube.com/watch?v=<id> identity. */
    videoId: text("video_id").notNull(),
    language: text("language"),
    /** [{ start, duration, text }], in seconds. */
    cues: jsonb("cues").notNull().default([]),
    /** True when the captions are auto-generated rather than authored. */
    generated: boolean("generated").notNull().default(false),
    /** The extraction row this transcript was filed with, so a re-fetch replaces it. */
    extractionId: uuid("extraction_id").references((): AnyPgColumn => documentExtractions.id, {
      onDelete: "set null",
    }),
    ...recorded,
  },
  (t) => [
    uniqueIndex("youtube_transcripts_document_key").on(t.documentId),
    index("youtube_transcripts_workspace_idx").on(t.workspaceId, t.videoId),
  ],
);

export const claims = pgTable("claims",
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
    targetType: linkTargetKind(),
    targetId: uuid("target_id").notNull(),
    label: text("label"),
    /** Why the edge exists (artifactLinkTypes); `reference` for explicit [[Title]] links. */
    linkType: artifactLinkType(),
    /** The passage or reason that justifies the edge, when one exists. */
    context: text("context"),
    /** Similarity confidence for `semantic` edges; null on explicit ones. */
    score: real("score"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("artifact_links_edge_key").on(t.artifactId, t.targetType, t.targetId),
    // Backlinks are the reverse read of the same row.
    index("artifact_links_target_idx").on(t.workspaceId, t.targetType, t.targetId),
    linkTargetKindCheck("artifact_links_target_type_check"),
    artifactLinkTypeCheck("artifact_links_link_type_check"),
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
  (t) => [
    index("claim_evidence_claim_idx").on(t.claimId),
    index("claim_evidence_source_idx").on(t.sourceId),
    index("claim_evidence_extraction_idx").on(t.extractionId),
  ],
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
    /** Where the chunk sits in the extraction text (same offsets as extraction spans), and its page. */
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    page: integer("page"),
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
  (t) => [
    uniqueIndex("dossier_sources_key").on(t.dossierId, t.sourceId),
    index("dossier_sources_source_idx").on(t.sourceId),
  ],
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
    ...recordedBy,
  },
  (t) => [uniqueIndex("canvas_versions_number_key").on(t.canvasId, t.versionNumber)],
);

/*
 * Document intelligence: what was extracted (field_proposals), who the document
 * is about (document_parties), what facts it evidences (reviewed_assertions),
 * and what paperwork it implies (document_obligations). Everything here is a
 * proposal until a human decides it; the assertion ledger is the only table
 * whose rows are accepted into the system of record, and it appends rather
 * than overwrites so "what did we believe on day N" stays answerable.
 */

export const documentPartyRole = pgEnum("document_party_role", [
  "subject",
  "sender",
  "recipient",
  "issuer",
  "signatory",
  "representative",
  "mentioned",
]);
export const documentPartyKind = pgEnum("document_party_kind", ["contact", "company"]);
export const partyResolutionStatus = pgEnum("party_resolution_status", [
  "unresolved",
  "matched",
  "created",
  "rejected",
]);
export const fieldProposalStatus = pgEnum("field_proposal_status", [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
]);
export const fieldKind = pgEnum("field_kind", [
  "date",
  "money",
  "text",
  "identifier",
  "person",
  "organization",
  "address",
  "other",
]);
export type FieldKind = (typeof fieldKind.enumValues)[number];
export const assertionStatus = pgEnum("assertion_status", ["active", "superseded", "retracted"]);
export const assertionSubjectType = pgEnum("assertion_subject_type", [
  "contact",
  "company",
  "project",
  "document",
]);
export const obligationStatus = pgEnum("obligation_status", [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
]);

export const documentParties = pgTable(
  "document_parties",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    partyRole: documentPartyRole("party_role").notNull(),
    partyKind: documentPartyKind("party_kind").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    /** The raw extracted name, before resolution to a contact or company. */
    displayName: text("display_name").notNull(),
    resolutionStatus: partyResolutionStatus("resolution_status").notNull().default("unresolved"),
    evidenceExtractionId: uuid("evidence_extraction_id").references(() => documentExtractions.id, {
      onDelete: "set null",
    }),
    evidenceSpans: jsonb("evidence_spans").notNull().default([]),
    ...mutable,
  },
  (t) => [
    // At most one target: both null is an unresolved party awaiting a human
    // decision, exactly one is resolved, both set is a double-counted one.
    check(
      "document_parties_one_target_check",
      sql`not (contact_id is not null and company_id is not null)`,
    ),
    uniqueIndex("document_parties_contact_key")
      .on(t.documentId, t.partyRole, t.contactId)
      .where(sql`contact_id is not null`),
    uniqueIndex("document_parties_company_key")
      .on(t.documentId, t.partyRole, t.companyId)
      .where(sql`company_id is not null`),
    index("document_parties_document_idx").on(t.documentId),
  ],
);

export const fieldProposals = pgTable(
  "field_proposals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => documentExtractions.id, { onDelete: "cascade" }),
    fieldKind: fieldKind("field_kind").notNull(),
    fieldName: text("field_name").notNull(),
    rawValue: text("raw_value"),
    /** An ambiguous date stays null; the note says why. */
    normalizedValue: jsonb("normalized_value"),
    normalizationNote: text("normalization_note"),
    confidence: text("confidence"),
    /** Stable per document+field context, so reprocessing finds its twin. */
    dedupeKey: text("dedupe_key").notNull(),
    status: fieldProposalStatus("status").notNull().default("proposed"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    /** What the user actually approved, when it differs from normalizedValue. */
    acceptedValue: jsonb("accepted_value"),
    evidenceSpans: jsonb("evidence_spans").notNull().default([]),
    /** Which party the value describes, when the proposer read it from that party's block. */
    partyRole: documentPartyRole("party_role"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("field_proposals_dedupe_key").on(t.documentId, t.dedupeKey),
    index("field_proposals_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

/*
 * Accepted facts live here as rows, never as overwrites. A corrected belief is
 * a new row that supersedes the old one; the old row keeps its value, status,
 * and evidence so the history is queryable rather than merely reconstructible.
 */
export const reviewedAssertions = pgTable(
  "reviewed_assertions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    subjectType: assertionSubjectType("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    attribute: text("attribute").notNull(),
    value: jsonb("value").notNull(),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    extractionId: uuid("extraction_id").references(() => documentExtractions.id, {
      onDelete: "set null",
    }),
    fieldProposalId: uuid("field_proposal_id").references(() => fieldProposals.id, {
      onDelete: "set null",
    }),
    evidenceSpans: jsonb("evidence_spans").notNull().default([]),
    /** Human-readable provenance: "supplied résumé v2". */
    sourceAttribution: text("source_attribution").notNull(),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    supersedesAssertionId: uuid("supersedes_assertion_id").references(
      (): AnyPgColumn => reviewedAssertions.id,
      { onDelete: "set null" },
    ),
    status: assertionStatus("status").notNull().default("active"),
    ...mutable,
  },
  (t) => [
    index("reviewed_assertions_subject_idx").on(
      t.workspaceId,
      t.subjectType,
      t.subjectId,
      t.attribute,
      t.status,
    ),
  ],
);

export const documentObligations = pgTable(
  "document_obligations",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    fieldProposalId: uuid("field_proposal_id").references(() => fieldProposals.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    note: text("note"),
    /** A date in a document is not a deadline until a human accepts it. */
    dueFromDocument: timestamp("due_from_document", { withTimezone: true }),
    dedupeKey: text("dedupe_key").notNull(),
    // No FK, matching tasks.actionProposalId: the work domain sets this when
    // the obligation is accepted, and knowledge does not depend on work.
    taskId: uuid("task_id"),
    status: obligationStatus("status").notNull().default("proposed"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    supersededBy: uuid("superseded_by"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("document_obligations_dedupe_key").on(t.documentId, t.dedupeKey),
    index("document_obligations_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

/*
 * A proposed zettel: one claim drawn from one succeeded document, with the
 * exact passage it rests on. Nothing here is knowledge until a human accepts
 * it; accepting writes the concept and the evidence link, rejecting writes
 * nothing else. The dedupe key follows obligationDedupeKey: a re-run lands on
 * the existing row.
 */
export const zettelProposals = pgTable(
  "zettel_proposals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => documentExtractions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    claim: text("claim").notNull(),
    /** The verbatim passage; span offsets index into the extraction text. */
    quote: text("quote").notNull(),
    spanStart: integer("span_start").notNull(),
    spanEnd: integer("span_end").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: zettelProposalStatus("status").notNull().default("proposed"),
    conceptId: uuid("concept_id"),
    claimId: uuid("claim_id"),
    /** The zettel artifact an accept created — the card in the graph. */
    artifactId: uuid("artifact_id").references((): AnyPgColumn => artifacts.id, { onDelete: "set null" }),
    proposer: text("proposer"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("zettel_proposals_dedupe_key").on(t.documentId, t.dedupeKey),
    index("zettel_proposals_workspace_status_idx").on(t.workspaceId, t.status),
    check("zettel_proposals_span_check", sql`span_start >= 0 AND span_end > span_start`),
  ],
);

/*
 * The document enrichment state machine (ASH-174/ASH-184): one row per
 * document per stage after capture and extraction. Stage rows are the record;
 * a failure is visible (`failed` + `last_error`) and retryable, and a restart
 * loses nothing because nothing about stage state lives in memory.
 */
export const ENRICHMENT_STAGES = ["extract", "embed", "zettels", "link"] as const;
export type EnrichmentStage = (typeof ENRICHMENT_STAGES)[number];
export const ENRICHMENT_STATUSES = ["pending", "running", "succeeded", "failed", "skipped"] as const;

export const documentEnrichment = pgTable(
  "document_enrichment",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    ...recorded,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("document_enrichment_document_stage_key").on(t.documentId, t.stage),
    index("document_enrichment_workspace_document_idx").on(t.workspaceId, t.documentId),
    check("document_enrichment_stage_check", sql.raw(`stage in (${ENRICHMENT_STAGES.map((k) => `'${k}'`).join(", ")})`)),
    check("document_enrichment_status_check", sql.raw(`status in (${ENRICHMENT_STATUSES.map((k) => `'${k}'`).join(", ")})`)),
    check("document_enrichment_attempts_check", sql`attempts >= 0`),
  ],
);

/*
 * The wiki layer (second brain). Documents stay the immutable raw sources;
 * the wiki is the maintained layer above them: one master index, one hub per
 * topic, one article per ingested document, and an append-only log. Each wiki
 * page is an artifact, so its content history lives in artifact_versions like
 * everything else; this table is the registry that says which artifact plays
 * which role, so the index and hubs are derived views that can be regenerated
 * instead of hand-edited, and re-ingesting a document lands on its existing
 * article rather than writing a second one.
 */
export const wikiPageRole = pgEnum("wiki_page_role", ["index", "topic", "article", "log"]);

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    role: wikiPageRole("role").notNull(),
    /** Topic hubs: the slug they collect. Null on every other role. */
    topicSlug: text("topic_slug"),
    /** Articles: the document they summarize. Null on every other role. */
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** Topics an article belongs to (slugs). Empty only between failed writes. */
    topicSlugs: jsonb("topic_slugs").notNull().default([]),
    /** The one-liner hubs and the index quote. */
    summary: text("summary"),
    /** The extraction the article was written from, like dossier_sources pins. */
    pinnedContentHash: text("pinned_content_hash"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("wiki_pages_singleton_key")
      .on(t.workspaceId, t.role)
      .where(sql`role in ('index', 'log')`),
    uniqueIndex("wiki_pages_topic_key")
      .on(t.workspaceId, t.topicSlug)
      .where(sql`role = 'topic'`),
    uniqueIndex("wiki_pages_article_key")
      .on(t.workspaceId, t.documentId)
      .where(sql`role = 'article'`),
    index("wiki_pages_workspace_role_idx").on(t.workspaceId, t.role),
  ],
);

/*
 * D18 (ASH-144): reading history and engagement on canonical documents. The
 * events are append-only truth - one sitting is a visitId, and progress
 * events carry the active-seconds delta since the last one so a lost close
 * never loses the time. The state row is the folded "where you are", updated
 * in the same transaction; furthest_progress never walks back.
 */
/** Event kinds, mirrored by the check constraint in 0070 (text + check, per house style). */
export const readingEventKinds = ["opened", "progress", "closed"] as const;
export type ReadingEventKind = (typeof readingEventKinds)[number];

export const documentReadingEvents = pgTable(
  "document_reading_events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** One browser sitting. Regenerated per reader mount, carried by every event of the sitting. */
    visitId: uuid("visit_id").notNull(),
    kind: text("kind").notNull().$type<ReadingEventKind>(),
    /** 0..1 of the extraction text scrolled into view; null on opened. */
    progress: real("progress"),
    page: integer("page"),
    /** Active (visible) seconds since the previous event of this sitting; capped server-side. */
    activeSeconds: integer("active_seconds"),
    /** Client-generated idempotency key; unique when present so a retried send folds once. */
    clientEventId: text("client_event_id"),
    ...recordedBy,
  },
  (t) => [
    uniqueIndex("document_reading_events_client_event_key")
      .on(t.workspaceId, t.documentId, t.userId, t.clientEventId)
      .where(sql`client_event_id is not null`),
    index("document_reading_events_document_idx").on(t.workspaceId, t.documentId, t.createdAt),
    index("document_reading_events_user_history_idx").on(t.workspaceId, t.userId, t.createdAt),
  ],
);

export const documentReadingState = pgTable(
  "document_reading_state",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }).notNull().defaultNow(),
    openCount: integer("open_count").notNull().default(0),
    totalActiveSeconds: integer("total_active_seconds").notNull().default(0),
    furthestProgress: real("furthest_progress").notNull().default(0),
    lastPage: integer("last_page"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("document_reading_state_document_user_key").on(t.workspaceId, t.documentId, t.userId),
    index("document_reading_state_user_recent_idx").on(t.workspaceId, t.userId, t.lastOpenedAt),
  ],
);

/*
 * B02 (ASH-143): classification proposals - the proposer (rules now, model
 * later behind the same row) suggests a doc type; the owner accepts or
 * rejects in the review workbench. One open proposal per (document,
 * proposer); accepted rows set documents.doc_type in the same transaction.
 */
export const documentClassificationProposals = pgTable(
  "document_classification_proposals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The extraction the classification was read from; survives its pruning. */
    extractionId: uuid("extraction_id").references((): AnyPgColumn => documentExtractions.id, {
      onDelete: "set null",
    }),
    proposedType: text("proposed_type").notNull().$type<import("./vocabulary").DocumentType>(),
    confidence: text("confidence").notNull().$type<"high" | "medium" | "low">(),
    /** The matched rules, shown in review as the basis. */
    signals: jsonb("signals").notNull().default([]).$type<string[]>(),
    /** e.g. "rules@v1"; a model proposer records model id + prompt version. */
    proposer: text("proposer").notNull(),
    status: text("status").notNull().default("proposed").$type<"proposed" | "accepted" | "rejected">(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("document_classification_open_key")
      .on(t.workspaceId, t.documentId, t.proposer)
      .where(sql`status = 'proposed'`),
    index("document_classification_document_idx").on(t.workspaceId, t.documentId),
  ],
);

/*
 * The rename manifest: every title change leaves who/what/why. Internal
 * only - the original filename on files is the provenance record and a
 * provider rename never happens (v1).
 */
export const documentRenameEvents = pgTable(
  "document_rename_events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    oldTitle: text("old_title").notNull(),
    newTitle: text("new_title").notNull(),
    /** The accepted field values the suggestion was composed from, if any. */
    basis: jsonb("basis").notNull().default({}).$type<Record<string, string>>(),
    source: text("source").notNull().$type<"suggested" | "manual" | "classification">(),
    ...recordedBy,
  },
  (t) => [index("document_rename_events_document_idx").on(t.workspaceId, t.documentId, t.createdAt)],
);

/*
 * Zettel cards and recall (Product Spec, "Zettel Cards and recall"). A card
 * is generated from a note or a claim, is reviewed before it circulates, and
 * always cites its source: artifactId is the note or zettel it came from, so
 * deleting the source cascades the card - an unsourced card must not survive
 * its source, the same honesty rule as claim_evidence.
 *
 * Review is retrieval, not recognition: a prompt and an answer, no options.
 * The spec's state list (proposed, scheduled, due, answered-correctly,
 * answered-wrong, suspended, retired) maps onto columns rather than one
 * enum: `state` holds proposed/scheduled/suspended/retired, "due" is
 * scheduled with dueAt <= now (derived, never stored), and
 * answered-correctly/answered-wrong is lastOutcome on a scheduled card.
 *
 * Scheduling lives in recall-scheduler.ts, the only place intervals are
 * computed. dueAt is the queue key; a wrong answer comes back within the
 * sitting, a correct one grows the interval.
 */
export const cardState = pgEnum("card_state", ["proposed", "scheduled", "suspended", "retired"]);
export const cardReviewOutcome = pgEnum("card_review_outcome", ["correct", "wrong"]);

export const cards = pgTable(
  "cards",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    prompt: text("prompt").notNull(),
    answer: text("answer").notNull(),
    /**
     * The note or zettel this card cites. Nullable + set-null on source
     * deletion: a card and its review history survive the source going away;
     * the citation lives on in sourceTitle. An archived source is handled in
     * the queries (out of the queue, still listed, marked) - not by unlinking.
     */
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    /**
     * Denormalized snapshot of the source's title, taken when the card is
     * proposed. This is what "a card always shows me where it came from"
     * degrades to when the source is deleted: the title survives the note.
     * Retention tradeoff, named: deleting a note leaves its title (not its
     * content) on cards that cited it; retiring the card removes the copy.
     */
    sourceTitle: text("source_title").notNull(),
    /** The claim inside the source, when the card tests one claim specifically. */
    // A card outlives the claim it was generated from: deleting the claim
    // must not silently cascade the card and its review history away.
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "set null" }),
    state: cardState("state").notNull().default("proposed"),
    lastOutcome: cardReviewOutcome("last_outcome"),
    /** Null while proposed or suspended: the card is outside the queue. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    intervalDays: integer("interval_days").notNull().default(0),
    easeFactor: real("ease_factor").notNull().default(2.5),
    reviewCount: integer("review_count").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [
    // The review queue: what is due in this workspace right now.
    index("cards_due_idx").on(t.workspaceId, t.dueAt).where(sql`state = 'scheduled'`),
    index("cards_workspace_state_idx").on(t.workspaceId, t.state),
    index("cards_artifact_idx").on(t.artifactId),
  ],
);

/*
 * Append-only attempt history. The card row is the projection; this is the
 * record "twelve cards in four minutes" is counted from, and the evidence
 * behind any per-topic weakness readout.
 */
export const cardReviews = pgTable(
  "card_reviews",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    outcome: cardReviewOutcome("outcome").notNull(),
    /** What the person said before the reveal, when they typed it. */
    responseText: text("response_text"),
    durationMs: integer("duration_ms"),
    ...recorded,
  },
  (t) => [
    index("card_reviews_card_idx").on(t.cardId, t.createdAt),
    index("card_reviews_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);
/*
 * Areas (Product Spec, "Areas and progress"): declared by the person, never
 * inferred. An area is a name plus the note tags it covers; effort and
 * knowledge confidence are computed from live content at read time, so the
 * table stores no counters to drift. Spec rules honored by construction:
 * areas are declared, not discovered; nothing here averages effort and
 * confidence into a single score.
 */
export const areas = pgTable(
  "areas",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    name: text("name").notNull(),
    /** The note tags this area covers (normalized like artifacts.tags). */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    // Live names are unique per workspace, case-insensitively; archiving
    // releases the name.
    uniqueIndex("areas_workspace_name_key").on(t.workspaceId, sql`lower(${t.name})`).where(sql`archived_at is null`),
    index("areas_workspace_idx").on(t.workspaceId, t.archivedAt),
  ],
);

