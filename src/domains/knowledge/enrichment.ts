import { and, asc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { embedArtifact, embedExtraction } from "./embedding";
import { ENRICHMENT_STAGES, documentEnrichment, documentExtractions, documents, zettelProposals, type EnrichmentStage } from "./schema";
import { proposeZettels } from "./zettels";

/*
 * The document enrichment state machine (ASH-174/ASH-184). After a source is
 * captured and its extraction succeeds, the stages that follow run in order:
 *
 *   extract  - already owned by extraction.ts; mirrored here, never re-run
 *   embed    - chunk + embed the succeeded extraction text (embedExtraction)
 *   zettels  - propose zettel cards from the text (proposeZettels)
 *   link     - embed the document's accepted zettel cards, so they join the
 *              semantic graph (embedArtifact per card)
 *
 * One row per document per stage is the whole state: a failure is a `failed`
 * row with `last_error`, visible and retryable, and a worker restart loses
 * nothing because nothing lives in memory. A stage only runs when the stage
 * before it succeeded; reruns are safe because each underlying pass is its
 * own idempotent boundary.
 */

export type EnrichmentRow = typeof documentEnrichment.$inferSelect;

type Providers = { embedding?: EmbeddingProvider; zettels?: ZettelExtractor };

/** Ensure the four stage rows exist for a document; returns them in pipeline order. */
export async function ensureDocumentEnrichment(auth: AuthContext, documentId: string): Promise<EnrichmentRow[]> {
  await db
    .insert(documentEnrichment)
    .values(ENRICHMENT_STAGES.map((stage) => ({ workspaceId: auth.workspaceId, documentId, stage })))
    .onConflictDoNothing({ target: [documentEnrichment.documentId, documentEnrichment.stage] });
  return getDocumentEnrichment(auth, documentId);
}

export async function getDocumentEnrichment(auth: AuthContext, documentId: string): Promise<EnrichmentRow[]> {
  return db
    .select()
    .from(documentEnrichment)
    .where(and(eq(documentEnrichment.workspaceId, auth.workspaceId), eq(documentEnrichment.documentId, documentId)))
    .orderBy(asc(documentEnrichment.createdAt), asc(documentEnrichment.stage));
}

/** The current extraction's status decides the mirrored extract row. */
async function mirrorExtract(auth: AuthContext, documentId: string): Promise<"succeeded" | "pending" | "failed"> {
  const [row] = await db
    .select({ status: documentExtractions.status })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.workspaceId, auth.workspaceId)))
    .orderBy(sql`${documentExtractions.createdAt} desc`)
    .limit(1);
  return !row ? "pending" : row.status === "succeeded" ? "succeeded" : row.status === "failed" ? "failed" : "pending";
}

async function mark(auth: AuthContext, documentId: string, stage: EnrichmentStage, set: Partial<typeof documentEnrichment.$inferInsert>) {
  await db
    .update(documentEnrichment)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(documentEnrichment.workspaceId, auth.workspaceId), eq(documentEnrichment.documentId, documentId), eq(documentEnrichment.stage, stage)));
}

async function runStage(
  auth: AuthContext,
  input: { documentId: string; stage: EnrichmentStage; providers?: Providers },
): Promise<{ ok: boolean; error?: string }> {
  const { documentId, stage } = input;
  await db
    .update(documentEnrichment)
    .set({ status: "running", attempts: sql`${documentEnrichment.attempts} + 1`, lastRunAt: new Date(), updatedAt: new Date() })
    .where(and(eq(documentEnrichment.workspaceId, auth.workspaceId), eq(documentEnrichment.documentId, documentId), eq(documentEnrichment.stage, stage)));
  const fail = async (error: string) => {
    await mark(auth, documentId, stage, { status: "failed", lastError: error });
    return { ok: false as const, error };
  };
  try {
    if (stage === "embed") {
      const [extraction] = await db
        .select({ id: documentExtractions.id })
        .from(documentExtractions)
        .where(and(
          eq(documentExtractions.documentId, documentId),
          eq(documentExtractions.workspaceId, auth.workspaceId),
          eq(documentExtractions.status, "succeeded"),
        ))
        .orderBy(sql`${documentExtractions.createdAt} desc`)
        .limit(1);
      if (!extraction) return fail("No succeeded extraction to embed.");
      const outcome = await embedExtraction(auth, { extractionId: extraction.id, provider: input.providers?.embedding });
      if (outcome.status === "failed") return fail(outcome.error);
    } else if (stage === "zettels") {
      await proposeZettels(auth, { documentId, extractor: input.providers?.zettels });
    } else if (stage === "link") {
      const cards = await db
        .select({ artifactId: zettelProposals.artifactId })
        .from(zettelProposals)
        .where(and(
          eq(zettelProposals.workspaceId, auth.workspaceId),
          eq(zettelProposals.documentId, documentId),
          eq(zettelProposals.status, "accepted"),
        ));
      for (const card of cards) {
        if (!card.artifactId) continue;
        const outcome = await embedArtifact(auth, { artifactId: card.artifactId, provider: input.providers?.embedding });
        if (outcome.status === "failed") return fail(outcome.error);
      }
    }
    await mark(auth, documentId, stage, { status: "succeeded", lastError: null });
    return { ok: true };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    await mark(auth, documentId, stage, { status: "failed", lastError: error });
    return { ok: false, error };
  }
}

/**
 * Advance the pipeline: mirror the extract stage, then run each due stage in
 * order, stopping at the first failure (later stages stay pending). Called
 * after a successful extraction, and by the retry control for a manual rerun.
 */
export async function advanceDocumentEnrichment(
  auth: AuthContext,
  input: { documentId: string; providers?: Providers },
): Promise<EnrichmentRow[]> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) throw new Error("document not found in workspace");

  const rows = await ensureDocumentEnrichment(auth, input.documentId);
  const extractState = await mirrorExtract(auth, input.documentId);
  await mark(auth, input.documentId, "extract", {
    status: extractState,
    ...(extractState === "failed" ? { lastError: "Extraction failed; retry extraction from the document." } : {}),
  });
  if (extractState !== "succeeded") return getDocumentEnrichment(auth, input.documentId);

  for (const stage of ENRICHMENT_STAGES.slice(1)) {
    const row = rows.find((r) => r.stage === stage);
    // The link stage re-runs even after success: accepting a zettel later adds
    // a card the last pass never saw, and embedArtifact is idempotent per card.
    if (!row || row.status === "skipped" || (row.status === "succeeded" && stage !== "link")) continue;
    const outcome = await runStage(auth, { documentId: input.documentId, stage, providers: input.providers });
    if (!outcome.ok) break;
  }
  return getDocumentEnrichment(auth, input.documentId);
}

/** A failed or pending stage may be retried on its own; later stages then advance. */
export async function retryDocumentEnrichment(
  auth: AuthContext,
  input: { documentId: string; providers?: Providers },
) {
  await withTransaction(async (tx) => {
    await tx
      .update(documentEnrichment)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(
        eq(documentEnrichment.workspaceId, auth.workspaceId),
        eq(documentEnrichment.documentId, input.documentId),
        eq(documentEnrichment.status, "failed"),
      ));
  });
  return advanceDocumentEnrichment(auth, input);
}
