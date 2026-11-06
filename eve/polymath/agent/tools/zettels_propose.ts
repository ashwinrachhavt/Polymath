import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { createZettelsFromSource } from "../../../../src/domains/knowledge/zettels";
import { db } from "../../../../src/lib/db";
import { documentExtractions, documents } from "../../../../src/domains/knowledge/schema";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

/*
 * Creates ideas (zettels) from material a run has in hand. The tool call is
 * the acceptance: the ideas become idea cards in the workspace's knowledge
 * graph immediately - no proposal row waits for a second human click. The
 * run's frozen policy must allow zettels.propose.
 *
 * When an artifactId is given, the text argument is ignored and the creation
 * pass reads the artifact's current version - the model cannot attribute a
 * quote to a body it invented. Free text goes through a transient document
 * keyed by the dedupe id, so a retry with the same id re-reads the same
 * stored source and re-dedupes against the cards it already made instead of
 * minting duplicates.
 */
export default defineTool({
  deferred: true,
  description:
    "Create ideas (zettels) from source text or a saved artifact. Ideas become knowledge cards immediately - the tool call is the acceptance, and near-duplicates of existing cards are skipped.",
  inputSchema: z.object({
    text: z.string().min(1).max(200_000),
    dedupeId: z.string().max(200),
    artifactId: z.string().uuid().optional(),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, "zettels.propose")) {
      return { ok: false as const, error: "The run's policy does not allow zettels.propose." };
    }
    // The agent principal acts with member authority; the run's frozen policy
    // (checked above) is the real gate. Same construction as wiki_ingest.ts.
    const auth = { userId: current.principalId, workspaceId, role: "member" as const };
    const result = input.artifactId
      ? await createZettelsFromSource(auth, { sourceArtifactId: input.artifactId })
      : await createZettelsFromSource(auth, {
          documentId: await resolveTransientDocument(workspaceId, input.dedupeId, input.text),
        });
    return {
      ok: true as const,
      created: result.created.map((c) => ({ id: c.artifactId, title: c.title })),
      skipped: {
        repeats: result.skippedRepeats,
        duplicates: result.skippedDuplicates,
        sameSpans: result.skippedSpans,
      },
      unreadChars: result.unreadChars,
    };
  },
});

/**
 * The transient document that holds free-text material for this dedupe id:
 * created once, then reused, so path-aware dedupe keys stay stable across
 * retries. The content hash is derived from the dedupe id (not the text) -
 * the id is the contract the caller chose.
 */
async function resolveTransientDocument(workspaceId: string, dedupeId: string, text: string): Promise<string> {
  const contentHash = createHash("sha256").update(`zettels_propose:${dedupeId}`).digest("hex");
  const [existing] = await db
    .select({ documentId: documentExtractions.documentId })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(and(eq(documentExtractions.workspaceId, workspaceId), eq(documentExtractions.contentHash, contentHash)))
    .limit(1);
  if (existing) return existing.documentId;

  const [document] = await db
    .insert(documents)
    .values({ workspaceId, title: "Agent source", mimeType: "text/plain" })
    .returning({ id: documents.id });
  const [extraction] = await db
    .insert(documentExtractions)
    .values({
      workspaceId,
      documentId: document.id,
      contentHash,
      status: "succeeded",
      text,
      extractor: "zettels_propose",
    })
    .returning({ id: documentExtractions.id });
  await db.update(documents).set({ activeExtractionId: extraction.id }).where(eq(documents.id, document.id));
  return document.id;
}
