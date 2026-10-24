import { and, count, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingUnconfiguredError,
  embeddingProvider,
  type EmbeddingProvider,
} from "@/integrations/embeddings/provider";
import { db } from "@/lib/db";
import { materializeSemanticEdges } from "./relations";
import { withTransaction } from "@/lib/db-transaction";
import { chunkText } from "./chunking";
import { artifacts, artifactVersions, documentExtractions, embeddings } from "./schema";

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
      const out = await withDeadline(provider.embed(batch, { signal: AbortSignal.timeout(EMBED_BATCH_TIMEOUT_MS) }), EMBED_BATCH_TIMEOUT_MS);
      if (out.length !== batch.length) throw new Error("The provider returned the wrong number of vectors.");
      vectors.push(...out);
    }
    if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`The provider returned vectors that are not ${EMBEDDING_DIMENSIONS} wide.`);
    }
  } catch (cause) {
    // Provider text can carry request details; keep the durable message generic.
    logProviderFailure("embedding failed for extraction", extraction.id, cause);
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

/*
 * Card embeddings (ASH-174/ASH-184): a note or zettel embeds like a document
 * extraction, with the artifact's current version as the embedded text.
 * Owner is the artifact row; `source_version_id` records which version the
 * vectors describe, so an edit followed by a re-embed replaces the old
 * version's chunks instead of mixing them. Best-effort like the extraction
 * pass: an unconfigured provider or a failed call lands on
 * `artifacts.embed_error` and never blocks a save.
 */
export const ARTIFACT_EMBEDDING_OWNER_TYPE = "artifact";

export type ArtifactEmbedOutcome =
  | { status: "succeeded"; chunks: number }
  | { status: "skipped"; reason: "not_found" | "no_text" | "busy" | "edited" }
  | { status: "failed"; error: string };

/*
 * The only strings ever persisted to artifacts.embed_error by this module -
 * authored here, never a provider/client payload. safeArtifactEmbedError maps
 * anything found in that column back to one of these (or a generic), so the
 * UI never renders raw text that could carry a secret, SQL, or request body
 * (the same leakage pattern the API-key surface needed #255 for).
 */
const SAFE_UNCONFIGURED = "No embedding provider configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY).";
const SAFE_SETUP = "The embedding provider could not be set up.";
const SAFE_FAILED = "Embedding could not complete. Retry to try again.";
const SAFE_UNKNOWN = "Indexing failed. Retry to try again.";

/*
 * Hosted logs are a disclosure surface too: an AI-SDK error can carry the
 * request body (the document text) and response details, and a hand-rolled
 * one can carry worse. Log the error CLASS and non-secret metadata only -
 * never .message, never bodies, never headers beyond the request id.
 */
function logProviderFailure(context: string, ownerId: string, cause: unknown) {
  const name = cause instanceof Error ? cause.name : "unknown";
  const statusCode = (cause as { statusCode?: unknown })?.statusCode;
  const status = typeof statusCode === "number" ? ` HTTP ${statusCode}` : "";
  const headers = (cause as { responseHeaders?: Record<string, string> })?.responseHeaders;
  const requestId = headers?.["x-request-id"] ? ` request ${headers["x-request-id"]}` : "";
  console.error(`${context} ${ownerId}: ${name}${status}${requestId}`);
}

export function safeArtifactEmbedError(error: string | null): string | null {
  if (!error) return null;
  if (error.includes("No embedding provider configured")) return SAFE_UNCONFIGURED;
  if (error.includes("could not be set up")) return SAFE_SETUP;
  if (error.includes("Embedding could not complete")) return SAFE_FAILED;
  return SAFE_UNKNOWN;
}

/** Bounds one provider batch; the pass holds a pool connection while it waits. */
export const EMBED_BATCH_TIMEOUT_MS = 30_000;

/*
 * The abort signal cancels a well-behaved transport; this deadline bounds the
 * AWAIT even when a provider ignores it, so the transaction, advisory lock
 * and pool slot are always released. The provider promise may outlive the
 * race in the worker; the signal ends its transport.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Embedding batch timed out.")), ms);
  });
  return Promise.race([work.finally(() => clearTimeout(timer)), deadline]);
}
/** Backstop for a provider that ignores the abort signal: the DB kills the idle tx, releasing the advisory lock and pool slot. */
const EMBED_TX_IDLE_TIMEOUT_MS = 120_000;

export async function embedArtifact(
  auth: AuthContext,
  input: { artifactId: string; provider?: EmbeddingProvider; batchTimeoutMs?: number },
): Promise<ArtifactEmbedOutcome> {
  const outcome = await withTransaction(async (tx): Promise<ArtifactEmbedOutcome> => {
    // One indexing pass per artifact at a time, across the PROVIDER CALL: a
    // double-click or a retry racing the commit-path embed joins here instead
    // of paying for a second metered batch. Try-lock, never queue - the loser
    // is told a pass is already running.
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${input.artifactId}, 0)) as got`)) as unknown as { got: boolean }[];
    if (!lock.got) return { status: "skipped", reason: "busy" };
    // A provider that hangs AND ignores the abort signal would otherwise pin
    // this transaction, its advisory lock, and the pool slot forever.
    // SET rejects bound parameters; the value is a module constant, inlined as a checked integer.
    await tx.execute(sql`set local idle_in_transaction_session_timeout = ${sql.raw(String(EMBED_TX_IDLE_TIMEOUT_MS | 0))}`);

    const [row] = await tx
      .select({
        id: artifacts.id,
        currentVersionId: artifacts.currentVersionId,
        plainText: artifactVersions.plainText,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row || !row.currentVersionId) return { status: "skipped", reason: "not_found" };
    const text = row.plainText ?? "";
    if (!text.trim()) return { status: "skipped", reason: "no_text" };

    const record = (error: string | null) =>
      tx.update(artifacts)
        .set({ embedError: error })
        .where(and(eq(artifacts.id, row.id), eq(artifacts.workspaceId, auth.workspaceId)));

    // Failure writes name the version they ran against. An edit committed
    // while this pass was in flight makes the recorded text stale: writing
    // the old version's failure onto the new version would mislabel it, so a
    // guarded write that lands on a moved version reports the race instead.
    // (Success already has the same guard below, before vectors are written.)
    const recordFailureIfCurrent = async (error: string): Promise<boolean> => {
      const written = await tx.update(artifacts)
        .set({ embedError: error })
        .where(and(
          eq(artifacts.id, row.id),
          eq(artifacts.workspaceId, auth.workspaceId),
          eq(artifacts.currentVersionId, row.currentVersionId!),
        ))
        .returning({ id: artifacts.id });
      return written.length > 0;
    };

    // A twin pass that finished first already indexed this version: join its
    // result, clear any stale recorded failure, and skip the metered call.
    const [existing] = await tx
      .select({ n: count() })
      .from(embeddings)
      .where(and(
        eq(embeddings.workspaceId, auth.workspaceId),
        eq(embeddings.ownerType, ARTIFACT_EMBEDDING_OWNER_TYPE),
        eq(embeddings.ownerId, row.id),
        eq(embeddings.sourceVersionId, row.currentVersionId),
      ));
    if (existing.n > 0) {
      await record(null);
      return { status: "succeeded", chunks: existing.n };
    }

    let provider: EmbeddingProvider;
    try {
      provider = input.provider ?? embeddingProvider();
    } catch (cause) {
      const error = cause instanceof EmbeddingUnconfiguredError ? cause.message : SAFE_SETUP;
      if (!(await recordFailureIfCurrent(error))) return { status: "skipped", reason: "edited" };
      return { status: "failed", error };
    }

    const chunks = chunkText(text);
    let vectors: number[][];
    try {
      vectors = [];
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => c.text);
        const budget = input.batchTimeoutMs ?? EMBED_BATCH_TIMEOUT_MS;
        const out = await withDeadline(provider.embed(batch, { signal: AbortSignal.timeout(budget) }), budget);
        if (out.length !== batch.length) throw new Error("The provider returned the wrong number of vectors.");
        vectors.push(...out);
      }
      if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(`The provider returned vectors that are not ${EMBEDDING_DIMENSIONS} wide.`);
      }
    } catch (cause) {
      logProviderFailure("embedding failed for artifact", row.id, cause);
      if (!(await recordFailureIfCurrent(SAFE_FAILED))) return { status: "skipped", reason: "edited" };
      return { status: "failed", error: SAFE_FAILED };
    }

    // An edit committed while the provider was working: the vectors describe
    // a version that is no longer current. Writing them (or clearing the
    // error the new version's own pass just recorded) would mark fresh text
    // as indexed on stale vectors, so this pass reports the race instead.
    const [fresh] = await tx
      .select({ currentVersionId: artifacts.currentVersionId })
      .from(artifacts)
      .where(and(eq(artifacts.id, row.id), eq(artifacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (fresh?.currentVersionId !== row.currentVersionId) return { status: "skipped", reason: "edited" };

    await tx.delete(embeddings).where(and(
      eq(embeddings.workspaceId, auth.workspaceId),
      eq(embeddings.ownerType, ARTIFACT_EMBEDDING_OWNER_TYPE),
      eq(embeddings.ownerId, row.id),
    ));
    for (let i = 0; i < chunks.length; i += 100) {
      await tx.insert(embeddings).values(
        chunks.slice(i, i + 100).map((chunk, offset) => ({
          workspaceId: auth.workspaceId,
          ownerType: ARTIFACT_EMBEDDING_OWNER_TYPE,
          ownerId: row.id,
          sourceVersionId: row.currentVersionId,
          chunkIndex: chunk.index,
          content: chunk.text,
          spanStart: chunk.start,
          spanEnd: chunk.end,
          embedding: vectors[i + offset],
          model: provider.model,
        })),
      );
    }
    await record(null);
    return { status: "succeeded", chunks: chunks.length };
  });
  // Best-effort: edges follow the vectors, but a failure here never fails the embed.
  if (outcome.status === "succeeded") {
    try {
      await materializeSemanticEdges(auth, input.artifactId);
    } catch (cause) {
      console.error(`semantic edges failed for artifact ${input.artifactId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return outcome;
}
