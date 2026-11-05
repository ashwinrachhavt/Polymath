import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import {
  artifactLinks,
  artifactVersions,
  artifacts,
  documentExtractions,
  documents,
  files,
} from "@/domains/knowledge/schema";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Sibling seeding at creation: creating a card writes durable `related`
 * edges from the new card to every already-created sibling card of the
 * same source — inside the one creation transaction. The semantic pass
 * skips explicitly-linked pairs, so these edges survive re-embeds; the last
 * test proves the skip is real (an unlinked note with the same embedding
 * still gains a semantic edge; the explicitly-linked sibling pair does not).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { embedArtifact } from "@/domains/knowledge/embedding";
import { materializeSemanticEdges } from "@/domains/knowledge/relations";
import { createZettelsFromSource } from "@/domains/knowledge/zettels";

function vec(dims: number[]): number[] {
  const v = new Array(1536).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
}
// Every unknown text falls back to the same basis vector, so all cards embed
// to one direction — distance 0, far inside the 0.45 semantic threshold.
const fakeProvider = (): EmbeddingProvider => ({
  model: "fake@1",
  embed: async (values) => values.map(() => vec([7])),
});

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

type Auth = ReturnType<typeof ownerAuth>;
const workspace = async (): Promise<Auth> => {
  const seed = await seedWorkspace(holder.db!, `zsb-${crypto.randomUUID()}`);
  return ownerAuth(seed.userId, seed.workspaceId);
};

const QUOTES = ["Rent is due monthly.", "The deposit is refundable.", "Pets need written consent."];
// Filler grows the source past the small-capture band (capForSize allows 2
// cards at <=2,000 chars) so every quoted candidate survives the pass cap.
const FILLER = "The remaining lease terms are recorded in the following paragraphs for the extractor to read past. ";
const SIBLING_TEXT = FILLER.repeat(14) + QUOTES.join(" ") + FILLER.repeat(14);
const siblingExtractor = (count: number) => ({
  name: "fake@1",
  extract: async () =>
    QUOTES.slice(0, count).map((quote, i) => ({
      title: `Claim ${i + 1}`,
      content: `Claim ${i + 1} statement.`,
      quote,
    })),
});

async function seedDoc(auth: Auth) {
  const db = holder.db!;
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "application/pdf",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: "lease", fileId: file.id, mimeType: "application/pdf" })
    .returning();
  await db.insert(documentExtractions).values({
    workspaceId: auth.workspaceId,
    documentId: doc.id,
    contentHash: crypto.randomUUID(),
    status: "succeeded",
    text: SIBLING_TEXT,
    extractor: "fixture@1",
  });
  return doc;
}

async function seedSourceArtifact(auth: Auth, title = "Conversation") {
  const db = holder.db!;
  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId: auth.workspaceId, kind: "note", title, createdBy: auth.userId, updatedBy: auth.userId })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { format: "markdown", text: SIBLING_TEXT },
      plainText: SIBLING_TEXT,
      reason: "created",
      createdBy: auth.userId,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  return artifact;
}

const relatedEdges = async (workspaceId: string) =>
  (
    await holder
      .db!.select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.workspaceId, workspaceId), eq(artifactLinks.linkType, "related")))
  ).map((r) => ({ from: r.artifactId, to: r.targetId, toType: r.targetType, label: r.label, context: r.context }));

const semanticPairs = async (workspaceId: string) =>
  (
    await holder
      .db!.select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.workspaceId, workspaceId), eq(artifactLinks.linkType, "semantic")))
  ).map((r) => [r.artifactId, r.targetId].sort().join("|"));

type RelatedEdge = { from: string; to: string; toType: string; label: string | null; context: string | null };
const byFromTo = (a: RelatedEdge, b: RelatedEdge) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
// Row order from Postgres is undefined — sort both sides before comparing.
const expectRelated = async (workspaceId: string, expected: RelatedEdge[]) =>
  expect((await relatedEdges(workspaceId)).sort(byFromTo)).toEqual(expected.sort(byFromTo));

suite("sibling seeding at creation (real Postgres)", () => {
  it("joins cards of one document as each creation lands", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);

    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: siblingExtractor(3),
    });
    expect(created).toHaveLength(3);
    const [a1, a2, a3] = created.map((c) => c.artifactId);

    await expectRelated(auth.workspaceId, [
      { from: a2, to: a1, toType: "zettel", label: "Claim 1", context: "From the same source" },
      { from: a3, to: a1, toType: "zettel", label: "Claim 1", context: "From the same source" },
      { from: a3, to: a2, toType: "zettel", label: "Claim 2", context: "From the same source" },
    ]);
  });

  it("joins cards of one source artifact (the chat/thread path)", async () => {
    const auth = await workspace();
    const source = await seedSourceArtifact(auth);

    const { created } = await createZettelsFromSource(auth, {
      sourceArtifactId: source.id,
      extractor: siblingExtractor(2),
    });
    expect(created).toHaveLength(2);
    const [a1, a2] = created.map((c) => c.artifactId);

    await expectRelated(auth.workspaceId, [
      { from: a2, to: a1, toType: "zettel", label: "Claim 1", context: "From the same source" },
    ]);
  });

  it("the semantic pass skips the explicit pair but still joins unlinked cards", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: siblingExtractor(2),
    });
    const [a1, a2] = created.map((c) => c.artifactId);

    // An unlinked neighbor: a plain note that embeds to the same direction.
    const db = holder.db!;
    const [note] = await db
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "note",
        title: "Unlinked",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    const [version] = await db
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: note.id,
        versionNumber: 1,
        content: { format: "markdown", text: "Unlinked note body." },
        plainText: "Unlinked note body.",
        reason: "created",
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, note.id));

    for (const id of [a1, a2, note.id]) {
      const result = await embedArtifact(auth, { artifactId: id, provider: fakeProvider() });
      expect(result.status).toBe("succeeded");
    }
    await materializeSemanticEdges(auth, a1);

    const pairs = await semanticPairs(auth.workspaceId);
    // The unlinked note joined: the pass itself works.
    expect(pairs).toContain([a1, note.id].sort().join("|"));
    // The explicit sibling pair did not: the related edge keeps the semantic
    // pass off it, so the edge survives re-embeds.
    expect(pairs).not.toContain([a1, a2].sort().join("|"));
  });
});
