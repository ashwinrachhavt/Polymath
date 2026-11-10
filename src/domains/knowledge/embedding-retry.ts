import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { enqueueOutbox, OutboxParkError, type ClaimedOutboxEvent, type OutboxHandler } from "@/domains/audit/outbox";
import type { AuthContext } from "@/domains/identity/resolve";
import { embeddingProvider, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { artifacts, artifactVersions, documentExtractions, documents } from "./schema";
import {
  ARTIFACT_EMBEDDING_OWNER_TYPE,
  EMBEDDING_OWNER_TYPE,
  EMBEDDING_RETRY_TOPIC,
  embeddingRetryDispatchKey,
  embedArtifact,
  embedExtraction,
  parseEmbeddingRetryPayload,
} from "./embedding";
import { SEARCH_KINDS } from "./retrieval";
import { currentExtractionSql } from "./versions";

/*
 * The self-healing half of the embedding pass. The inline embed is
 * best-effort, so a failure (or a skipped pass, or a model switch) leaves
 * content dark to the meaning leg; retrieval.ts counts that population
 * honestly but nothing re-drives it. Two halves live here:
 *
 * - sweepUncoveredEmbeddings: the bounded producer. It selects uncovered
 *   owners - no same-model vectors for the current version - and cuts one
 *   durable retry order per owner. Rerun when everything is covered, it
 *   selects nothing: second run no-ops.
 * - the handler for EMBEDDING_RETRY_TOPIC: the consumer. It re-runs the same
 *   embedArtifact/embedExtraction the commit paths use, which are idempotent,
 *   so redelivery converges instead of duplicating.
 *
 * Coverage is model-aware on purpose. search.ts reads only vectors whose
 * `model` matches the current provider, so vectors from a retired model are
 * dead weight and must not read as coverage here either.
 */

export { EMBEDDING_RETRY_TOPIC };

/** One sweep pass takes at most this many owners per kind of store. */
export const EMBEDDING_RETRY_SWEEP_LIMIT = 50;
export const EMBEDDING_RETRY_SWEEP_MAX = 200;

/** Bounds are clamp-hard: a caller passing 0 or -5 still gets a real pass of one. */
export function clampSweepLimit(input?: number): number {
  if (input === undefined || Number.isNaN(input)) return EMBEDDING_RETRY_SWEEP_LIMIT;
  return Math.min(Math.max(Math.trunc(input), 1), EMBEDDING_RETRY_SWEEP_MAX);
}

export type EmbeddingRetrySweep = {
  /** Uncovered owners selected this pass (bounded by the clamped limit per store). */
  scanned: number;
  /** Retry orders actually cut; an order already live for the key dedupes to nothing. */
  enqueued: number;
  /** The model the coverage check and the orders used - the provider search will read. */
  model: string;
};

/**
 * The bounded pass over the uncovered population. The provider resolves up
 * front: its model defines coverage, and without one there is nothing to
 * embed with and no model to be covered under, so that is an error, not an
 * empty sweep. Selection mirrors countMeaningUncovered's predicates
 * (text present, current version, no vectors for it) with the same-model
 * guard added, and orders freshest-first so a bounded pass heals what a
 * person most likely still wants first.
 */
export async function sweepUncoveredEmbeddings(
  auth: Pick<AuthContext, "workspaceId">,
  input: { limit?: number; provider?: EmbeddingProvider } = {},
): Promise<EmbeddingRetrySweep> {
  const provider = input.provider ?? embeddingProvider();
  const limit = clampSweepLimit(input.limit);

  const artifactRows = await db
    .select({ id: artifacts.id, versionId: artifacts.currentVersionId })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        isNull(artifacts.archivedAt),
        sql`length(trim(coalesce(${artifactVersions.plainText}, ''))) > 0`,
        inArray(artifacts.kind, [...SEARCH_KINDS]),
        sql`not exists (
        select 1 from embeddings e
        where e.workspace_id = ${auth.workspaceId}
          and e.owner_type = ${ARTIFACT_EMBEDDING_OWNER_TYPE}
          and e.owner_id = ${artifacts.id}
          and e.source_version_id = ${artifacts.currentVersionId}
          and e.model = ${provider.model}
      )`,
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(limit);

  const extractionRows = await db
    .select({ id: documentExtractions.id })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(documentExtractions.workspaceId, auth.workspaceId),
        isNull(documents.archivedAt),
        eq(documentExtractions.status, "succeeded"),
        sql`length(trim(coalesce(${documentExtractions.text}, ''))) > 0`,
        // The current extraction only: superseded versions are never read by
        // search (versions.ts owns "current"), so re-driving them buys nothing.
        sql`${documentExtractions.id}::text = ${currentExtractionSql("id")}`,
        sql`not exists (
        select 1 from embeddings e
        where e.workspace_id = ${auth.workspaceId}
          and e.owner_type = ${EMBEDDING_OWNER_TYPE}
          and e.owner_id = ${documentExtractions.id}
          and e.model = ${provider.model}
      )`,
      ),
    )
    .orderBy(desc(documentExtractions.createdAt))
    .limit(limit);

  const work = [
    ...artifactRows
      .filter((row): row is { id: string; versionId: string } => row.versionId !== null)
      .map((row) => ({ ownerType: "artifact" as const, ownerId: row.id, versionToken: row.versionId })),
    ...extractionRows.map((row) => ({
      ownerType: "document_extraction" as const,
      ownerId: row.id,
      versionToken: row.id,
    })),
  ];
  if (work.length === 0) return { scanned: 0, enqueued: 0, model: provider.model };

  let enqueued = 0;
  await withTransaction(async (tx) => {
    for (const item of work) {
      const result = await enqueueOutbox(tx, auth, {
        topic: EMBEDDING_RETRY_TOPIC,
        payload: { ownerType: item.ownerType, ownerId: item.ownerId },
        dispatchKey: embeddingRetryDispatchKey(item.ownerType, item.ownerId, item.versionToken, provider.model),
      });
      if (result.enqueued) enqueued += 1;
    }
  });
  return { scanned: work.length, enqueued, model: provider.model };
}

/**
 * The consumer for a retry order. Fails the attempt on a provider failure
 * (the dispatcher backs off and retries, dead-lettering at the ceiling),
 * parks when another pass holds the advisory lock (no attempt spent - that
 * pass may yet succeed on its own), and completes on every terminal-honest
 * outcome: vectors written, or genuinely nothing to index (missing, empty,
 * or a version that moved on and has its own pass).
 */
export function embeddingRetryRequestedHandler(
  resolveAuth: (workspaceId: string) => Promise<AuthContext | null>,
  options: { provider?: EmbeddingProvider } = {},
): OutboxHandler {
  return async (event: ClaimedOutboxEvent) => {
    const work = parseEmbeddingRetryPayload(event.payload);
    // A payload this producer never wrote must fail loudly, never complete
    // as a success that did nothing (the crawl handler's rule).
    if (!work) throw new Error(`${EMBEDDING_RETRY_TOPIC} has a malformed payload; redeploy the producer`);
    const auth = await resolveAuth(event.workspaceId);
    if (!auth) throw new Error("workspace has no active owner to act for the embedding retry");

    const outcome =
      work.ownerType === "artifact"
        ? await embedArtifact(auth, { artifactId: work.ownerId, provider: options.provider })
        : await embedExtraction(auth, { extractionId: work.ownerId, provider: options.provider });

    if (outcome.status === "failed") throw new Error(outcome.error);
    if (outcome.status === "skipped" && outcome.reason === "busy") {
      throw new OutboxParkError(60_000, "an embedding pass holds the advisory lock");
    }
  };
}
