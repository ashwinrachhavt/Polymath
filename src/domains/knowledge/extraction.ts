import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { createDoclingDockerProvider } from "@/integrations/extraction/docling-docker";
import { createLlamaParseProvider } from "@/integrations/extraction/llamaparse";
import { createPdfTextLayerProvider } from "@/integrations/extraction/pdf-text-layer";
import { createPlainTextProvider } from "@/integrations/extraction/plain-text";
import type {
  ExtractedField,
  ExtractionProvider,
  ExtractionResult,
  ExtractionSpan,
} from "@/integrations/extraction/provider";
import { readBlob } from "@/integrations/object-store/object-store";
import { blobObjects } from "../audit/schema";
import { embedExtraction } from "./embedding";
import { proposeFromText, RULES_PROPOSER } from "./field-rules";
import { flagConflicts, proposeFields } from "./fields";
import { proposeObligationsFromDocument } from "./obligations";
import { proposeClassification } from "./classify";
import { canonicalFieldName } from "./vocabulary";
import { proposeParties } from "./parties";
import { documentExtractionAttempts, documentExtractions, documents, files } from "./schema";
import { clearRestoreOnNewExtraction } from "./versions";

/*
 * The extraction command: file bytes in provider, durable rows out. Extraction
 * is versioned by content hash (unique on (documentId, contentHash)), so
 * re-running an improved extractor is a new row and every span that pointed at
 * the old extraction stays answerable.
 *
 * Provider resolution: docling-serve in docker locally; LlamaParse on Vercel
 * where the docker is unreachable. Env decides — the presence of each
 * provider's URL/key picks the adapter; the text-layer reader is the floor.
 */

export async function extractionProvider(): Promise<ExtractionProvider> {
  const doclingUrl = process.env.DOCLING_SERVE_URL;
  if (doclingUrl) return createDoclingDockerProvider(doclingUrl);
  const llamaKey = process.env.LLAMAPARSE_API_KEY;
  if (llamaKey) return createLlamaParseProvider(llamaKey);
  // The in-process reader is the floor in every environment: it needs no
  // secrets, so a text-layer PDF (a resume, an export) always reads. No OCR -
  // a scan or an image fails with the message naming the provider it needs.
  return createPdfTextLayerProvider();
}

/** Where the proposal pass stands after this call: done now, done before, failed, or another caller holds it. */
export type ProposalOutcome = "succeeded" | "already_done" | "failed" | "in_progress";

/**
 * How long a caller owns a pending extraction. Longer than any provider call we
 * allow, short enough that a killed process is retryable the same afternoon.
 */
export const EXTRACTION_LEASE_SECONDS = 600;

export type ExtractDocumentResult =
  | { ok: true; extractionId: string; text: string; deduplicated: boolean; proposals: ProposalOutcome }
  | { ok: false; error: string; extractionId: string | null };

/**
 * Runs extraction for one document and writes the extraction row. The blob
 * must already exist (uploaded through the files route); this reads it from
 * object storage, parses it, and records text plus spans against the document.
 */
export async function extractDocument(
  auth: AuthContext,
  input: { documentId: string; leaseSeconds?: number },
): Promise<ExtractDocumentResult> {
  // One token per call. Only the holder of the current token may write the
  // result, so a process that outlives its lease cannot overwrite a newer try.
  const claimedBy = `${process.pid}:${crypto.randomUUID()}`;
  const leaseSeconds = input.leaseSeconds ?? EXTRACTION_LEASE_SECONDS;
  const [document] = await db
    .select({ id: documents.id, fileId: documents.fileId, mimeType: documents.mimeType })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new Error("document not found in workspace");

  if (!document.fileId) return { ok: false, error: "document has no file", extractionId: null };

  // The file's blob content hash is the extraction version key; read it here,
  // where the workspace scope is already proven.
  const [blob] = await db
    .select({ contentHash: blobObjects.contentHash, storageKey: blobObjects.storageKey })
    .from(files)
    .innerJoin(blobObjects, eq(blobObjects.id, files.blobId))
    .where(and(
      eq(files.id, document.fileId),
      eq(files.workspaceId, auth.workspaceId),
      eq(blobObjects.workspaceId, auth.workspaceId),
    ))
    .limit(1);
  if (!blob) return { ok: false, error: "file has no stored blob", extractionId: null };
  const contentHash = blob.contentHash;

  const scope = and(
    eq(documentExtractions.workspaceId, auth.workspaceId),
    eq(documentExtractions.documentId, input.documentId),
    eq(documentExtractions.contentHash, contentHash),
  );
  // Claim before provider I/O. The unique key admits only one initial attempt.
  // A retry may take the row only from `failed`, or from `pending` once its
  // lease has expired (the process that held it died). `succeeded` and
  // `skipped` are never reclaimed. The UPDATE is one atomic statement: of two
  // racing callers the second re-checks the lease after the first stamps it.
  const [created] = await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      contentHash,
      status: "pending",
      claimedAt: sql`now()`,
      claimedBy,
    })
    .onConflictDoNothing({
      target: [documentExtractions.documentId, documentExtractions.contentHash],
    })
    .returning({ id: documentExtractions.id });
  // A genuinely new version supersedes any restore pin (versions.ts).
  if (created) await clearRestoreOnNewExtraction(input.documentId);
  const leaseExpired = lt(
    sql`coalesce(${documentExtractions.claimedAt}, ${documentExtractions.createdAt})`,
    sql`now() - make_interval(secs => ${leaseSeconds})`,
  );
  // `error` is left as is: the failure that made this a retry stays visible
  // until the retry succeeds, and its attempt row keeps it either way.
  const [retried] = created ? [] : await db
    .update(documentExtractions)
    .set({ status: "pending", claimedAt: sql`now()`, claimedBy })
    .where(and(
      scope,
      or(
        eq(documentExtractions.status, "failed"),
        and(eq(documentExtractions.status, "pending"), leaseExpired),
      ),
    ))
    .returning({ id: documentExtractions.id });
  const claim = created ?? retried;
  if (!claim) {
    const [existing] = await db
      .select({
        id: documentExtractions.id,
        status: documentExtractions.status,
        text: documentExtractions.text,
        spans: documentExtractions.spans,
        error: documentExtractions.error,
        embeddedAt: documentExtractions.embeddedAt,
      })
      .from(documentExtractions)
      .where(scope)
      .limit(1);
    if (existing?.status === "succeeded") {
      // Text is durable evidence and is never re-read; the proposal pass has
      // its own boundary and reruns here if it failed or never ran.
      const text = existing.text ?? "";
      const proposals = await runProposalPass(auth, {
        documentId: input.documentId,
        extractionId: existing.id,
        text,
        spans: existing.spans as ExtractionSpan[],
      });
      await embedAfterText(auth, existing.id, existing.embeddedAt);
      return { ok: true, extractionId: existing.id, text, deduplicated: true, proposals };
    }
    return {
      ok: false,
      extractionId: existing?.id ?? null,
      error: existing?.status === "pending"
        ? "Extraction is already in progress. Refresh to see its result."
        : existing?.error ?? "Extraction has not succeeded.",
    };
  }

  const attempt = await openAttempt(auth, claim.id, claimedBy);
  const mine = and(scope, eq(documentExtractions.id, claim.id), eq(documentExtractions.claimedBy, claimedBy));
  let result: ExtractionResult;
  try {
    // Text needs no parsing provider: the stored bytes are the reading text.
    const provider = document.mimeType?.startsWith("text/")
      ? createPlainTextProvider()
      : await extractionProvider();
    const bytes = await readBlob(blob.storageKey);
    result = await provider.extract({
      bytes,
      filename: input.documentId,
      mimeType: document.mimeType ?? "application/octet-stream",
    });
  } catch (cause) {
    // Setup/storage/transport exceptions must release the retry claim too. Keep
    // provider credentials out of the durable error; the boundary handles cause.
    await db.update(documentExtractions)
      .set({ status: "failed", error: "Extraction could not complete. Check the provider and retry." })
      .where(and(mine, eq(documentExtractions.status, "pending")));
    await closeAttempt(attempt, "failed", "Extraction could not complete. Check the provider and retry.");
    throw cause;
  }

  const [row] = await db.update(documentExtractions)
    .set({
      status: result.ok ? "succeeded" : "failed",
      text: result.ok ? result.text : null,
      spans: result.ok ? result.spans : [],
      extractor: result.extractor,
      error: result.ok ? null : result.error,
    })
    .where(and(mine, eq(documentExtractions.status, "pending")))
    .returning({ id: documentExtractions.id });
  if (!row) {
    // The lease expired and another caller took the row; this result is stale.
    await closeAttempt(attempt, "abandoned", "Lease was reclaimed before this attempt finished.");
    return { ok: false, error: "Extraction claim is no longer available.", extractionId: claim.id };
  }
  await closeAttempt(attempt, result.ok ? "succeeded" : "failed", result.ok ? null : result.error);
  if (!result.ok) return { ok: false, error: result.error, extractionId: row.id };

  const proposals = await runProposalPass(auth, {
    documentId: input.documentId,
    extractionId: row.id,
    text: result.text,
    spans: result.spans,
    providerFields: result.fields,
    extractor: result.extractor,
  });
  await embedAfterText(auth, row.id, null);
  return { ok: true, extractionId: row.id, text: result.text, deduplicated: false, proposals };
}

/**
 * Chunks the text once it has succeeded, and again on a later call only if the
 * first embed never landed. It never throws and never touches the extraction's
 * status: a failed embed is recorded on `embed_error` and the text stays valid.
 */
async function embedAfterText(auth: AuthContext, extractionId: string, embeddedAt: Date | null): Promise<void> {
  if (embeddedAt) return;
  try {
    await embedExtraction(auth, { extractionId });
  } catch (cause) {
    console.error(`embedding pass threw for extraction ${extractionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

type Attempt = { id: string };

/**
 * Writes the attempt row for a claim just taken. Any attempt still open on this
 * extraction belonged to a holder that lost the lease, so it closes as
 * abandoned with its error left to say why. Rows are only ever added or closed.
 */
async function openAttempt(auth: AuthContext, extractionId: string, claimedBy: string): Promise<Attempt> {
  await db.update(documentExtractionAttempts)
    .set({ finishedAt: sql`now()`, outcome: "abandoned", error: "Lease expired before the extraction finished." })
    .where(and(
      eq(documentExtractionAttempts.extractionId, extractionId),
      isNull(documentExtractionAttempts.finishedAt),
    ));
  const [row] = await db.insert(documentExtractionAttempts)
    .values({
      workspaceId: auth.workspaceId,
      extractionId,
      attempt: sql`coalesce((select max(attempt) from document_extraction_attempts where extraction_id = ${extractionId}), 0) + 1`,
      claimedBy,
    })
    .returning({ id: documentExtractionAttempts.id });
  return row;
}

async function closeAttempt(
  attempt: Attempt,
  outcome: "succeeded" | "failed" | "abandoned",
  error: string | null,
): Promise<void> {
  await db.update(documentExtractionAttempts)
    .set({ finishedAt: sql`now()`, outcome, error })
    .where(and(eq(documentExtractionAttempts.id, attempt.id), isNull(documentExtractionAttempts.finishedAt)));
}

/** A pending proposal claim older than this was abandoned by a dead process and may be retaken. */
const PROPOSAL_CLAIM_TTL = "5 minutes";

/**
 * The proposal pass: fields, parties, then obligations, from one succeeded
 * extraction. Its own retry boundary (proposal_status on the extraction row),
 * claimed before work so two callers never run it at once, and idempotent
 * underneath (dedupe keys on fields and obligations, role+name twins on
 * parties), so a retry after a partial failure only fills what is missing.
 * Its failure never invalidates the text evidence; it is recorded and visible.
 */
async function runProposalPass(
  auth: AuthContext,
  input: {
    documentId: string;
    extractionId: string;
    text: string;
    spans: ExtractionSpan[];
    providerFields?: ExtractedField[];
    extractor?: string;
  },
): Promise<ProposalOutcome> {
  const thisRow = and(
    eq(documentExtractions.id, input.extractionId),
    eq(documentExtractions.workspaceId, auth.workspaceId),
  );
  const [claim] = await db
    .update(documentExtractions)
    .set({ proposalStatus: "pending", proposalError: null, proposalClaimedAt: new Date() })
    .where(and(
      thisRow,
      eq(documentExtractions.status, "succeeded"),
      or(
        isNull(documentExtractions.proposalStatus),
        eq(documentExtractions.proposalStatus, "failed"),
        and(
          eq(documentExtractions.proposalStatus, "pending"),
          lt(documentExtractions.proposalClaimedAt, sql`now() - ${PROPOSAL_CLAIM_TTL}::interval`),
        ),
      ),
    ))
    .returning({ id: documentExtractions.id });
  if (!claim) {
    const [current] = await db
      .select({ proposalStatus: documentExtractions.proposalStatus })
      .from(documentExtractions)
      .where(thisRow)
      .limit(1);
    return current?.proposalStatus === "succeeded" ? "already_done" : "in_progress";
  }

  // Provider fields win when a provider emits them; otherwise the rules read
  // the text. Parties always come from the rules: no provider reports them.
  // ponytail: provider fields are not persisted, so a retried pass after a
  // provider-fields failure falls back to rules; persist them when a provider
  // that emits fields is actually configured.
  const rules = proposeFromText(input.text, input.spans);
  const useProvider = Boolean(input.providerFields?.length);
  // ASH-133 item 2: provider field names alias to the canonical vocabulary at
  // this boundary, so obligation rules and the totals check read the same
  // names the rules proposer emits.
  const fields = (useProvider ? input.providerFields ?? [] : rules.fields).map((field) => ({
    ...field,
    fieldName: canonicalFieldName(field.fieldName),
  }));
  try {
    await proposeFields(auth, {
      documentId: input.documentId,
      extractionId: input.extractionId,
      fields: flagConflicts(fields),
      currencyHint: rules.currencyHint,
    });
    // B02 (ASH-143): classification joins the same review step as a proposal.
    await proposeClassification(auth, {
      documentId: input.documentId,
      extractionId: input.extractionId,
      text: input.text,
      fieldNames: fields.map((f) => f.fieldName),
    });
    await proposeParties(auth, {
      documentId: input.documentId,
      extractionId: input.extractionId,
      candidates: rules.parties,
    });
    await proposeObligationsFromDocument(auth, { documentId: input.documentId });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`proposal pass failed for document ${input.documentId}: ${message}`);
    await db.update(documentExtractions)
      .set({
        proposalStatus: "failed",
        proposalError: "Fields could not be proposed from the extracted text. Retry to try again.",
      })
      .where(and(thisRow, eq(documentExtractions.proposalStatus, "pending")));
    return "failed";
  }

  await db.update(documentExtractions)
    .set({
      proposalStatus: "succeeded",
      proposer: useProvider ? (input.extractor ?? null) : RULES_PROPOSER,
    })
    .where(and(thisRow, eq(documentExtractions.proposalStatus, "pending")));
  return "succeeded";
}
