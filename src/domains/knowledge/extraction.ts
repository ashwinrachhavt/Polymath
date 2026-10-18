import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { createDoclingDockerProvider } from "@/integrations/extraction/docling-docker";
import { createLlamaParseProvider } from "@/integrations/extraction/llamaparse";
import type { ExtractionProvider } from "@/integrations/extraction/provider";
import { blobObjects } from "../audit/schema";
import { flagConflicts, proposeFields } from "./fields";
import { documentExtractions, documents, files } from "./schema";

/*
 * The extraction command: file bytes in provider, durable rows out. Extraction
 * is versioned by content hash (unique on (documentId, contentHash)), so
 * re-running an improved extractor is a new row and every span that pointed at
 * the old extraction stays answerable.
 *
 * Provider resolution: docling-serve in docker locally; LlamaParse on Vercel
 * where the docker is unreachable. Env decides — the presence of each
 * provider's URL/key picks the adapter.
 */

export async function extractionProvider(): Promise<ExtractionProvider> {
  const doclingUrl = process.env.DOCLING_SERVE_URL;
  if (doclingUrl) return createDoclingDockerProvider(doclingUrl);
  const llamaKey = process.env.LLAMAPARSE_API_KEY;
  if (llamaKey) return createLlamaParseProvider(llamaKey);
  throw new Error(
    "No extraction provider configured. Set DOCLING_SERVE_URL (local docker) or LLAMAPARSE_API_KEY (hosted).",
  );
}

export type ExtractDocumentResult =
  | { ok: true; extractionId: string; text: string; deduplicated: boolean }
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
    .where(and(eq(files.id, document.fileId), eq(files.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!blob) return { ok: false, error: "file has no stored blob", extractionId: null };
  const contentHash = blob.contentHash;

  // Already-extracted content: the unique key is the dedupe, not a re-run.
  const [existing] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text })
    .from(documentExtractions)
    .where(
      and(
        eq(documentExtractions.documentId, input.documentId),
        eq(documentExtractions.contentHash, contentHash),
      ),
    )
    .limit(1);
  if (existing) {
    return { ok: true, extractionId: existing.id, text: existing.text ?? "", deduplicated: true };
  }

  const bytes = await readStoredBlob(blob.storageKey);
  const provider = await extractionProvider();
  const result = await provider.extract({
    bytes,
    filename: input.documentId,
    mimeType: document.mimeType ?? "application/octet-stream",
  });

  const status = result.ok ? "succeeded" : "failed";
  const [row] = await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      contentHash,
      status,
      text: result.ok ? result.text : null,
      spans: result.ok ? result.spans : [],
      extractor: result.extractor,
      error: result.ok ? null : result.error,
    })
    .onConflictDoNothing({
      target: [documentExtractions.documentId, documentExtractions.contentHash],
    })
    .returning({ id: documentExtractions.id });

  if (row) {
    if (!result.ok) return { ok: false, error: result.error, extractionId: row.id };

    // Field proposals ride on top of a successful extraction but must never
    // sink it: plain text is the floor a document search depends on, structured
    // fields are an enhancement. A failed proposal batch leaves the extraction
    // row intact and logs; the next extraction run re-proposes (idempotent).
    if (result.fields?.length) {
      try {
        await proposeFields(auth, {
          documentId: input.documentId,
          extractionId: row.id,
          fields: flagConflicts(result.fields),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`field proposal failed for document ${input.documentId}: ${message}`);
      }
    }

    return { ok: true, extractionId: row.id, text: result.text, deduplicated: false };
  }

  // Lost the insert race: another writer recorded the same extraction first.
  const [winner] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text })
    .from(documentExtractions)
    .where(
      and(
        eq(documentExtractions.documentId, input.documentId),
        eq(documentExtractions.contentHash, contentHash),
      ),
    )
    .limit(1);
  return { ok: true, extractionId: winner?.id ?? null, text: winner?.text ?? "", deduplicated: true };
}

/** Reads the stored blob bytes through its storage key. Vercel Blob primary, R2 documented (D2). */
async function readStoredBlob(storageKey: string): Promise<Uint8Array> {
  const res = await fetch(storageKey);
  if (!res.ok) throw new Error(`blob unreadable: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
