import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { artifacts, claims, documents, documentExtractions, embeddings } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 19 corpus dedup, now a create-time gate. The claim embedder is stubbed
 * to return the unit vector e1 for every candidate; the existing cards in the
 * corpus are seeded with hand-written vectors at chosen cosine distances from
 * it. Within 0.15 the candidate is skipped - no second card is minted; at
 * 0.30 (merely related) the card is created.
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
      content: "The tenant pays rent on the first of each month.",
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
  await db.insert(claims).values({
    workspaceId: auth.workspaceId,
    artifactId: idea.id,
    statement: "The tenant pays rent on the first of each month.",
    status: "proposed",
    createdBy: auth.userId,
    updatedBy: auth.userId,
  });
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

suite("corpus dedupe at create time (real Postgres)", () => {
  it("a near-duplicate of an existing card is skipped, not minted", async () => {
    const { auth, documentId } = await seedDocument("dup", TEXT);
    await seedIdea(auth, "Prior idea", 0.08);

    const { createZettelsFromSource } = await import("@/domains/knowledge/zettels");
    const result = await createZettelsFromSource(auth, { documentId, extractor });

    expect(result.created).toEqual([]);
    expect(result.skippedDuplicates).toBe(1);
    const cards = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")));
    // Only the seeded prior idea remains: the near-duplicate candidate was
    // skipped, not minted.
    expect(cards.map((c) => c.title)).toEqual(["Prior idea"]);
  });

  it("a merely-related candidate still creates its card", async () => {
    const { auth, documentId } = await seedDocument("related", TEXT);
    await seedIdea(auth, "Related idea", 0.3);

    const { createZettelsFromSource } = await import("@/domains/knowledge/zettels");
    const result = await createZettelsFromSource(auth, { documentId, extractor });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Rent timing");
  });
});
