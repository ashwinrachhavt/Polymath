import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { artifacts, documents, documentExtractions, embeddings } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 19 corpus dedup. The claim embedder is stubbed to return the unit
 * vector e1 for every candidate; the accepted ideas in the corpus are seeded
 * with hand-written vectors at chosen cosine distances from it. Within 0.15
 * the proposal is flagged with the idea's id; at 0.30 (merely related) it is
 * not. Accepting a flagged proposal still creates the artifact — the flag
 * never decides.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("@/integrations/embeddings/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/embeddings/provider")>();
  return {
    ...actual,
    embeddingProvider: () => ({
      model: "test-embed",
      embed: async () => [[1, ...Array.from({ length: actual.EMBEDDING_DIMENSIONS - 1 }, () => 0)]],
    }),
  };
});

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const QUOTE = "The tenant pays rent on the first of each month.";
const TEXT = `Preamble sentence. ${QUOTE} Follow-up sentence.`;

/** A seeded extraction whose single section yields one valid candidate. */
const extractor = {
  name: "fake",
  extract: async () => [
    {
      title: "Rent timing",
      claim: "The tenant pays rent on the first of each month.",
      quote: QUOTE,
      start: TEXT.indexOf(QUOTE),
      end: TEXT.indexOf(QUOTE) + QUOTE.length,
    },
  ],
};

/** Seeds a fresh workspace whose document carries a succeeded extraction with `text`. */
async function seedDocument(label: string, text: string) {
  const db = holder.db!;
  const seed = await seedWorkspace(db, `zdup-${label}-${Date.now()}`);
  const auth = ownerAuth(seed.userId, seed.workspaceId);
  const [document] = await db
    .insert(documents)
    .values({
      workspaceId: auth.workspaceId,
      title: "Lease",
      mimeType: "text/plain",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  await db.insert(documentExtractions).values({
    workspaceId: auth.workspaceId,
    documentId: document.id,
    contentHash: crypto.randomUUID(),
    status: "succeeded",
    text,
    extractor: "fixture@1",
  });
  return { auth, documentId: document.id };
}

/**
 * Seeds an accepted idea with a hand-written embedding at cosine distance `d`
 * from the unit vector the stubbed provider returns for every claim. Unit
 * vectors: v[0] = 1 - d fixes the angle, the second coordinate closes the norm.
 */
async function seedIdea(auth: ReturnType<typeof ownerAuth>, title: string, d: number) {
  const db = holder.db!;
  const [idea] = await db
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: "zettel",
      title,
      status: "reviewed",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  const c = 1 - d;
  const s = Math.sqrt(1 - c * c);
  await db.insert(embeddings).values({
    workspaceId: auth.workspaceId,
    ownerType: "artifact",
    ownerId: idea.id,
    chunkIndex: 0,
    content: title,
    model: "test-embed",
    embedding: [c, s, ...Array.from({ length: 1534 }, () => 0)],
  });
  return idea;
}

suite("corpus dedup against accepted ideas (real Postgres)", () => {
  it("flags a candidate within the duplicate distance with the idea's id", async () => {
    const { auth, documentId } = await seedDocument("dup", TEXT);
    const idea = await seedIdea(auth, "Prior idea", 0.08);

    const { proposeZettels, listZettelProposals } = await import("@/domains/knowledge/zettels");
    const result = await proposeZettels(auth, { documentId, extractor });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.duplicateOfArtifactId).toBe(idea.id);

    // The review surface reads the flag as a link. No audit row exists (the
    // pass ran outside capture), so the read report defaults to zero/unknown.
    const listed = await listZettelProposals(auth, documentId);
    expect(listed.proposals[0]?.duplicateOf).toEqual({ id: idea.id, title: "Prior idea" });
    expect(listed.readChars).toBe(0);
    expect(listed.unreadChars).toBe(0);
  });

  it("does not flag a merely-related candidate", async () => {
    const { auth, documentId } = await seedDocument("related", TEXT);
    await seedIdea(auth, "Related idea", 0.3);

    const { proposeZettels, listZettelProposals } = await import("@/domains/knowledge/zettels");
    const result = await proposeZettels(auth, { documentId, extractor });
    expect(result.proposals[0]?.duplicateOfArtifactId).toBeNull();
    const listed = await listZettelProposals(auth, documentId);
    expect(listed.proposals[0]?.duplicateOf).toBeNull();
  });

  it("accepting a flagged proposal still creates the artifact", async () => {
    const { auth, documentId } = await seedDocument("accept", TEXT);
    const idea = await seedIdea(auth, "Prior idea", 0.08);

    const { proposeZettels, acceptZettel } = await import("@/domains/knowledge/zettels");
    const [proposal] = (await proposeZettels(auth, { documentId, extractor })).proposals;
    const accepted = await acceptZettel(auth, { proposalId: proposal.id });

    expect(accepted.artifactId).not.toBe(idea.id);
    const [card] = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.id, accepted.artifactId), eq(artifacts.workspaceId, auth.workspaceId)));
    expect(card.kind).toBe("zettel");
    expect(card.title).toBe("Rent timing");
  });

  it("reports the pass's read counts from the latest audit row", async () => {
    const { auth, documentId } = await seedDocument("counts", TEXT);
    const { listZettelProposals } = await import("@/domains/knowledge/zettels");
    const { auditEvents } = await import("@/domains/audit/schema");
    await holder.db!.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      action: "capture.zettels_proposed",
      subjectType: "capture",
      summary: "Proposed 1 zettel for review",
      metadata: { documentId, readChars: 12_000, unreadChars: 423 },
    });

    const listed = await listZettelProposals(auth, documentId);
    expect(listed.readChars).toBe(12_000);
    expect(listed.unreadChars).toBe(423);
  });
});
