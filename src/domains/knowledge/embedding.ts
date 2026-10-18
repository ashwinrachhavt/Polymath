import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingUnconfiguredError,
  embeddingProvider,
  type EmbeddingProvider,
} from "@/integrations/embeddings/provider";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { chunkText } from "./chunking";
import { documentExtractions, embeddings } from "./schema";

/*
 * The embedding pass: chunk the text a succeeded extraction already holds and
 * write one `embeddings` row per chunk. It is its own boundary, like the
 * proposal pass. It reads `document_extractions.text`, never the file, so a
 * failed embed costs no second PDF read, and a failure is recorded on
 * `embed_error` without ever touching the extraction's `status`.
 *
 * The owner of a chunk is the extraction row, which is the version of the text
 * (its content hash is the version key). Re-running replaces that version's
 * chunks inside one transaction, so a second pass cannot double them and a
 * failed pass leaves the previous chunks in place.
 */

export const EMBEDDING_OWNER_TYPE = "document_extraction";

export type EmbedOutcome =
  | { status: "succeeded"; chunks: number }
  | { status: "skipped"; reason: "not_succeeded" | "no_text" | "not_found" }
  | { status: "failed"; error: string };

/** Batches keep one provider call small; the provider itself may split further. */
const BATCH_SIZE = 64;

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function embedExtraction(
  auth: AuthContext,
  input: { extractionId: string; provider?: EmbeddingProvider },
): Promise<EmbedOutcome> {
  const [extraction] = await db
    .select({
      id: documentExtractions.id,
      status: documentExtractions.status,
      text: documentExtractions.text,
      spans: documentExtractions.spans,
    })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.id, input.extractionId), eq(documentExtractions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!extraction) return { status: "skipped", reason: "not_found" };
  // Embeddings are derived from text, so no succeeded text means nothing to do.
  if (extraction.status !== "succeeded") return { status: "skipped", reason: "not_succeeded" };
  const text = extraction.text ?? "";
  if (!text.trim()) return { status: "skipped", reason: "no_text" };

  const record = (error: string) =>
    db.update(documentExtractions)
      .set({ embedError: error })
      .where(and(eq(documentExtractions.id, extraction.id), eq(documentExtractions.workspaceId, auth.workspaceId)));

  let provider: EmbeddingProvider;
  try {
    provider = input.provider ?? embeddingProvider();
  } catch (cause) {
    const error = cause instanceof EmbeddingUnconfiguredError ? cause.message : "The embedding provider could not be set up.";
    await record(error);
    return { status: "failed", error };
  }

  const chunks = chunkText(text, extraction.spans as { page: number; start: number; end: number }[]);
  let vectors: number[][];
  try {
    vectors = [];
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => c.text);
      const out = await provider.embed(batch);
      if (out.length !== batch.length) throw new Error("The provider returned the wrong number of vectors.");
      vectors.push(...out);
    }
    if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`The provider returned vectors that are not ${EMBEDDING_DIMENSIONS} wide.`);
    }
  } catch (cause) {
    // Provider text can carry request details; keep the durable message generic.
    console.error(`embedding failed for extraction ${extraction.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    const error = "Embedding could not complete. Retry to try again.";
    await record(error);
    return { status: "failed", error };
  }

  await withTransaction(async (tx) => {
    // One replace at a time per extraction; a concurrent pass waits, then replaces again.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${extraction.id}, 0))`);
    await tx.delete(embeddings).where(and(
      eq(embeddings.workspaceId, auth.workspaceId),
      eq(embeddings.ownerType, EMBEDDING_OWNER_TYPE),
      eq(embeddings.ownerId, extraction.id),
    ));
    for (let i = 0; i < chunks.length; i += 100) {
      await tx.insert(embeddings).values(
        chunks.slice(i, i + 100).map((chunk, offset) => ({
          workspaceId: auth.workspaceId,
          ownerType: EMBEDDING_OWNER_TYPE,
          ownerId: extraction.id,
          sourceVersionId: extraction.id,
          chunkIndex: chunk.index,
          content: chunk.text,
          spanStart: chunk.start,
          spanEnd: chunk.end,
          page: chunk.page,
          embedding: vectors[i + offset],
          model: provider.model,
        })),
      );
    }
    await tx.update(documentExtractions)
      .set({ embeddedAt: new Date(), embedModel: provider.model, embedError: null })
      .where(and(eq(documentExtractions.id, extraction.id), eq(documentExtractions.workspaceId, auth.workspaceId)));
  });
  return { status: "succeeded", chunks: chunks.length };
}

export { vectorLiteral };
