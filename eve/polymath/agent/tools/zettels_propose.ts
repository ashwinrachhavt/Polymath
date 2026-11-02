import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { proposeZettels } from "../../../../src/domains/knowledge/zettels";
import { db } from "../../../../src/lib/db";
import { documentExtractions, documents } from "../../../../src/domains/knowledge/schema";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

/*
 * Proposes ideas (zettels) from material a run has in hand. The proposal-only
 * clause is the whole point: rows land in the owner's review queue, and the
 * owner's accept is the only path that creates an idea artifact. The run's
 * frozen policy must allow zettels.propose.
 *
 * When an artifactId is given, the text argument is ignored and the proposal
 * pass reads the artifact's current version - the model cannot attribute a
 * quote to a body it invented. Free text goes through a transient document
 * keyed by the dedupe id, so a retry with the same id re-reads the same
 * stored source and resolves the same proposals instead of queuing duplicates.
 */
export default defineTool({
  description:
    "Propose ideas (zettels) from source text or a saved artifact. Proposals wait in the owner's review queue; the tool does not create any idea artifact.",
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
      ? await proposeZettels(auth, { sourceArtifactId: input.artifactId })
      : await proposeZettels(auth, {
          documentId: await resolveTransientDocument(workspaceId, input.dedupeId, input.text),
        });
    return {
      ok: true as const,
      proposals: result.proposals.map((p) => ({ id: p.id, duplicateOf: p.duplicateOfArtifactId })),
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
