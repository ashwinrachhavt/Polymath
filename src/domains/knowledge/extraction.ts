import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { createDoclingDockerProvider } from "@/integrations/extraction/docling-docker";
import { createLlamaParseProvider } from "@/integrations/extraction/llamaparse";
import { createPdfTextLayerProvider } from "@/integrations/extraction/pdf-text-layer";
import type {
  ExtractedField,
  ExtractionProvider,
  ExtractionResult,
  ExtractionSpan,
} from "@/integrations/extraction/provider";
import { readBlob } from "@/integrations/object-store/object-store";
import { blobObjects } from "../audit/schema";
import { proposeFromText, RULES_PROPOSER } from "./field-rules";
import { flagConflicts, proposeFields } from "./fields";
import { proposeObligationsFromDocument } from "./obligations";
import { proposeParties } from "./parties";
import { documentExtractions, documents, files } from "./schema";

/*
 * The extraction command: file bytes in provider, durable rows out. Extraction
 * is versioned by content hash (unique on (documentId, contentHash)), so
 * re-running an improved extractor is a new row and every span that pointed at
 * the old extraction stays answerable.
 *
 * Provider resolution: docling-serve in docker locally; LlamaParse on Vercel
 * where the docker is unreachable. Env decides — the presence of each
 * provider's URL/key picks the adapter. With neither, development reads the
 * PDF's own text layer in process so the loop runs without secrets;
 * production fails closed and the route reports the missing configuration.
 */

export async function extractionProvider(): Promise<ExtractionProvider> {
  const doclingUrl = process.env.DOCLING_SERVE_URL;
  if (doclingUrl) return createDoclingDockerProvider(doclingUrl);
  const llamaKey = process.env.LLAMAPARSE_API_KEY;
  if (llamaKey) return createLlamaParseProvider(llamaKey);
  if (process.env.NODE_ENV !== "production") return createPdfTextLayerProvider();
  throw new Error(
    "No extraction provider configured. Set DOCLING_SERVE_URL (local docker) or LLAMAPARSE_API_KEY (hosted).",
  );
}

/** Where the proposal pass stands after this call: done now, done before, failed, or another caller holds it. */
export type ProposalOutcome = "succeeded" | "already_done" | "failed" | "in_progress";

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
  input: { documentId: string },
): Promise<ExtractDocumentResult> {
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
  // Claim before provider I/O. The unique key admits only one initial attempt;
  // failed -> pending admits only one retry. Never rewrite successful evidence.
  const [created] = await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      contentHash,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [documentExtractions.documentId, documentExtractions.contentHash],
    })
    .returning({ id: documentExtractions.id });
  const [retried] = created ? [] : await db
    .update(documentExtractions)
    .set({ status: "pending", error: null })
    .where(and(scope, eq(documentExtractions.status, "failed")))
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

  let result: ExtractionResult;
  try {
    const provider = await extractionProvider();
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
      .where(and(scope, eq(documentExtractions.id, claim.id), eq(documentExtractions.status, "pending")));
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
    .where(and(scope, eq(documentExtractions.id, claim.id), eq(documentExtractions.status, "pending")))
    .returning({ id: documentExtractions.id });
  if (!row) return { ok: false, error: "Extraction claim is no longer available.", extractionId: claim.id };
  if (!result.ok) return { ok: false, error: result.error, extractionId: row.id };

  const proposals = await runProposalPass(auth, {
    documentId: input.documentId,
    extractionId: row.id,
    text: result.text,
    spans: result.spans,
    providerFields: result.fields,
    extractor: result.extractor,
  });
  return { ok: true, extractionId: row.id, text: result.text, deduplicated: false, proposals };
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
  const fields = useProvider ? input.providerFields ?? [] : rules.fields;
  try {
    await proposeFields(auth, {
      documentId: input.documentId,
      extractionId: input.extractionId,
      fields: flagConflicts(fields),
      currencyHint: rules.currencyHint,
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
