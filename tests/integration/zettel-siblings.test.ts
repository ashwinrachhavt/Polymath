import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import {
  artifactLinks,
  artifactVersions,
  artifacts,
  documents,
  files,
  zettelProposals,
} from "@/domains/knowledge/schema";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Sibling seeding at accept: accepting a proposal writes durable `related`
 * edges from the new card to every already-accepted sibling proposal of the
 * same source — inside acceptZettel's one transaction. The semantic pass
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
import { acceptZettel } from "@/domains/knowledge/zettels";

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
  return doc;
}

async function seedSourceArtifact(auth: Auth, title = "Conversation") {
  const db = holder.db!;
  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId: auth.workspaceId, kind: "note", title, createdBy: auth.userId, updatedBy: auth.userId })
    .returning({ id: artifacts.id });
  return artifact;
}

async function seedProposal(auth: Auth, source: { documentId?: string; sourceArtifactId?: string }, i: number) {
  const db = holder.db!;
  const [row] = await db
    .insert(zettelProposals)
    .values({
      workspaceId: auth.workspaceId,
      documentId: source.documentId ?? null,
      sourceArtifactId: source.sourceArtifactId ?? null,
      title: `Claim ${i}`,
      claim: `Claim ${i} statement.`,
      quote: `Quote number ${i} verbatim.`,
      spanStart: i * 100,
      spanEnd: i * 100 + 20,
      dedupeKey: crypto.randomUUID(),
      proposer: "test@1",
    })
    .returning();
  return row;
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

suite("sibling seeding at accept (real Postgres)", () => {
  it("joins accepted cards of one document as each accept lands", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    const p1 = await seedProposal(auth, { documentId: doc.id }, 1);
    const p2 = await seedProposal(auth, { documentId: doc.id }, 2);
    const p3 = await seedProposal(auth, { documentId: doc.id }, 3);

    const a1 = await acceptZettel(auth, { proposalId: p1.id });
    expect(await relatedEdges(auth.workspaceId)).toEqual([]);

    const a2 = await acceptZettel(auth, { proposalId: p2.id });
    expect(await relatedEdges(auth.workspaceId)).toEqual([
      { from: a2.artifactId, to: a1.artifactId, toType: "zettel", label: "Claim 1", context: "From the same source" },
    ]);

    const a3 = await acceptZettel(auth, { proposalId: p3.id });
    expect(await relatedEdges(auth.workspaceId)).toEqual([
      { from: a2.artifactId, to: a1.artifactId, toType: "zettel", label: "Claim 1", context: "From the same source" },
      { from: a3.artifactId, to: a1.artifactId, toType: "zettel", label: "Claim 1", context: "From the same source" },
      { from: a3.artifactId, to: a2.artifactId, toType: "zettel", label: "Claim 2", context: "From the same source" },
    ]);
  });

  it("joins accepted cards of one source artifact (the chat/thread path)", async () => {
    const auth = await workspace();
    const source = await seedSourceArtifact(auth);
    const p1 = await seedProposal(auth, { sourceArtifactId: source.id }, 1);
    const p2 = await seedProposal(auth, { sourceArtifactId: source.id }, 2);

    const a1 = await acceptZettel(auth, { proposalId: p1.id });
    const a2 = await acceptZettel(auth, { proposalId: p2.id });
    expect(await relatedEdges(auth.workspaceId)).toEqual([
      { from: a2.artifactId, to: a1.artifactId, toType: "zettel", label: "Claim 1", context: "From the same source" },
    ]);
  });

  it("the semantic pass skips the explicit pair but still joins unlinked cards", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    const p1 = await seedProposal(auth, { documentId: doc.id }, 1);
    const p2 = await seedProposal(auth, { documentId: doc.id }, 2);
    const a1 = await acceptZettel(auth, { proposalId: p1.id });
    const a2 = await acceptZettel(auth, { proposalId: p2.id });

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

    for (const id of [a1.artifactId, a2.artifactId, note.id]) {
      const result = await embedArtifact(auth, { artifactId: id, provider: fakeProvider() });
      expect(result.status).toBe("succeeded");
    }
    await materializeSemanticEdges(auth, a1.artifactId);

    const pairs = await semanticPairs(auth.workspaceId);
    // The unlinked note joined: the pass itself works.
    expect(pairs).toContain([a1.artifactId, note.id].sort().join("|"));
    // The explicit sibling pair did not: the related edge keeps the semantic
    // pass off it, so the edge survives re-embeds.
    expect(pairs).not.toContain([a1.artifactId, a2.artifactId].sort().join("|"));
  });
});
