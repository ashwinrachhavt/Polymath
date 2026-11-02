import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts, documentExtractions, documents, zettelProposals } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The proposals seam (plan Task 6): once document_id is nullable, Postgres
 * treats NULLs as distinct and the 0012 (document_id, dedupe_key) index stops
 * constraining artifact-sourced rows. The partial index on
 * (source_artifact_id, dedupe_key) restores the guarantee; the one-source
 * check keeps every row naming exactly one origin. The 0012 index itself is
 * untouched — document-sourced proposals must stay unique on their own key.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

suite("zettel_proposals source seam (migration 0273)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let artifactId: string;
  let documentId: string;

  async function insertProposal(input: { documentId?: string; artifactId?: string; dedupeKey: string }) {
    return holder.db!.insert(zettelProposals).values({
      workspaceId: auth.workspaceId,
      title: "A claim",
      claim: "The claim body",
      quote: "The verbatim passage",
      spanStart: 0,
      spanEnd: 4,
      dedupeKey: input.dedupeKey,
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      ...(input.artifactId === undefined ? {} : { sourceArtifactId: input.artifactId }),
    });
  }

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `seam-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);

    const [artifact] = await holder.db
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "note",
        title: "Thread run",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    artifactId = artifact.id;
    const [document] = await holder.db
      .insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "Source document" })
      .returning({ id: documents.id });
    documentId = document.id;
    await holder.db
      .insert(documentExtractions)
      .values({ workspaceId: auth.workspaceId, documentId, contentHash: "seam-test-hash" });
  });

  it("rejects a second proposal for the same artifact span", async () => {
    // Without the partial index, NULL document_id makes both rows distinct.
    await expect(insertProposal({ artifactId, dedupeKey: "zettel:artifact:a:0-20" })).resolves.toBeDefined();
    await expect(insertProposal({ artifactId, dedupeKey: "zettel:artifact:a:0-20" })).rejects.toThrow();
  });

  it("refuses a row naming both a document and an artifact", async () => {
    await expect(insertProposal({ documentId, artifactId, dedupeKey: "k" })).rejects.toThrow();
  });

  it("keeps document-sourced proposals unique on their own key", async () => {
    await expect(insertProposal({ documentId, dedupeKey: "zettel:doc:d:0-20" })).resolves.toBeDefined();
    await expect(insertProposal({ documentId, dedupeKey: "zettel:doc:d:0-20" })).rejects.toThrow();
  });
});
