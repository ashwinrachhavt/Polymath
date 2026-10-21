import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, embeddings } from "@/domains/knowledge/schema";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-174/ASH-184: cards embed like documents, and the semantic half of the
 * knowledge graph ranks a card's nearest neighbours by cosine distance.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { ARTIFACT_EMBEDDING_OWNER_TYPE, embedArtifact } from "@/domains/knowledge/embedding";
import { autosaveNoteDraft, commitNoteSnapshot, createNote, getNote, listNoteBacklinks, listNoteOutlinks, synthesizeZettel } from "@/domains/knowledge/notes";
import { dismissSemanticLink, linkCards, listCardGraph, removeLink, setLinkRelation, materializeSemanticEdges, promoteSemanticLink, relatedNotes } from "@/domains/knowledge/relations";

/** Deterministic 1536-wide vectors: basis directions per key. */
function vec(dims: number[]): number[] {
  const v = new Array(1536).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
}
const fakeProvider = (byText: Record<string, number[]>): EmbeddingProvider => ({
  model: "fake@1",
  embed: async (values) => values.map((t) => byText[t] ?? vec([0])),
});

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `sr-${crypto.randomUUID()}`), role: "owner" as const });

async function writeNote(auth: { workspaceId: string; userId: string; role: "owner" }, title: string, text: string) {
  const note = await createNote(auth, { title });
  await commitNoteSnapshot(auth, {
    artifactId: note.id,
    expectedVersion: 1,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    plainText: text,
  });
  return note;
}

suite("card embeddings and semantic relations (real Postgres)", () => {
  it("embeds a note's committed version and re-embed replaces, never doubles", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Alpha", "alpha body text");
    const provider = fakeProvider({ "alpha body text": vec([1]) });

    const first = await embedArtifact(auth, { artifactId: note.id, provider });
    expect(first).toEqual({ status: "succeeded", chunks: 1 });
    const again = await embedArtifact(auth, { artifactId: note.id, provider });
    expect(again).toEqual({ status: "succeeded", chunks: 1 });

    const rows = await holder.db!.select().from(embeddings).where(and(
      eq(embeddings.workspaceId, auth.workspaceId),
      eq(embeddings.ownerType, ARTIFACT_EMBEDDING_OWNER_TYPE),
      eq(embeddings.ownerId, note.id),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("fake@1");

    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, note.id));
    expect(card.embedError).toBeNull();
  });

  it("the commit hook records an unconfigured provider on the card and never blocks the save", async () => {
    const auth = await workspace();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const note = await writeNote(auth, "Beta", "beta body text");
    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, note.id));
    expect(card.embedError).toContain("No embedding provider configured");
  });

  it("ranks nearest cards by cosine distance and marks explicit links", async () => {
    const auth = await workspace();
    const a = await writeNote(auth, "Rent law", "rent law body");
    const b = await writeNote(auth, "Rent control", "rent control body");
    const c = await writeNote(auth, "Cooking", "cooking body");
    // A and B point the same way; C is orthogonal (cosine distance 1).
    const provider = fakeProvider({
      "rent law body": vec([5]),
      "rent control body": vec([5]),
      "cooking body": vec([9]),
    });
    for (const n of [a, b, c]) await embedArtifact(auth, { artifactId: n.id, provider });

    const related = await relatedNotes(auth, a.id);
    expect(related.map((r) => r.id)).toEqual([b.id]);
    expect(related[0].score).toBeCloseTo(1, 5);
    expect(related[0].kind).toBe("note");
    expect(related[0].excerpt).toBe("rent control body");
    expect(related[0].alreadyLinked).toBe(false);

    // An explicit edge flips the flag, so the panel can keep the two halves distinct.
    await autosaveNoteDraft(auth, {
      artifactId: a.id,
      expectedVersion: 2,
      content: { type: "doc", content: [] },
      plainText: "rent law body\n\nSee [[Rent control]].",
    });
    const after = await relatedNotes(auth, a.id);
    expect(after[0].alreadyLinked).toBe(true);
  });

  it("a card with no embedding has no semantic relations, and foreign workspaces never leak", async () => {
    const auth = await workspace();
    const other = await workspace();
    const a = await writeNote(auth, "Lonely", "lonely body");
    const outsider = await writeNote(other, "Outsider", "lonely body");
    const provider = fakeProvider({ "lonely body": vec([3]) });
    await embedArtifact(other, { artifactId: outsider.id, provider });

    expect(await relatedNotes(auth, a.id)).toEqual([]);
    expect(await relatedNotes(other, outsider.id)).toEqual([]);
  });

  it("an embed materializes semantic edges, and a new card surfaces on existing cards at once", async () => {
    const auth = await workspace();
    const a = await writeNote(auth, "Deep work", "deep body");
    const b = await writeNote(auth, "Focus", "focus body");
    const provider = fakeProvider({ "deep body": vec([2]), "focus body": vec([2]) });
    await embedArtifact(auth, { artifactId: a.id, provider });
    expect(await relatedNotes(auth, a.id)).toEqual([]);
    await embedArtifact(auth, { artifactId: b.id, provider });
    // b embedded after a: the edge is b -> a, yet a sees b immediately.
    expect((await relatedNotes(auth, a.id)).map((r) => r.id)).toEqual([b.id]);
    expect((await relatedNotes(auth, b.id)).map((r) => r.id)).toEqual([a.id]);
    const edges = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.workspaceId, auth.workspaceId));
    expect(edges).toHaveLength(1);
    expect(edges[0].linkType).toBe("semantic");
    // Re-embedding rewrites, never doubles; semantic edges stay out of outlinks/backlinks.
    await embedArtifact(auth, { artifactId: b.id, provider });
    expect(await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.workspaceId, auth.workspaceId))).toHaveLength(1);
    expect(await listNoteOutlinks(auth, b.id)).toEqual([]);
    expect(await listNoteBacklinks(auth, a.id)).toEqual([]);
  });

  it("confirming a suggestion promotes it to a durable related edge that survives re-embed", async () => {
    const auth = await workspace();
    const a = await writeNote(auth, "One", "one body");
    const b = await writeNote(auth, "Two", "two body");
    const provider = fakeProvider({ "one body": vec([4]), "two body": vec([4]) });
    for (const n of [a, b]) await embedArtifact(auth, { artifactId: n.id, provider });
    expect(await promoteSemanticLink(auth, { artifactId: a.id, targetId: b.id })).toBe(true);
    const [edge] = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.workspaceId, auth.workspaceId));
    expect(edge).toMatchObject({ artifactId: a.id, targetId: b.id, linkType: "related" });
    expect((await listNoteOutlinks(auth, a.id)).map((l) => l.id)).toEqual([b.id]);
    await embedArtifact(auth, { artifactId: b.id, provider });
    const after = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.workspaceId, auth.workspaceId));
    expect(after).toHaveLength(1);
    expect(after[0].linkType).toBe("related");
    expect(await promoteSemanticLink(auth, { artifactId: a.id, targetId: b.id })).toBe(false);
  });

  it("materialization is idempotent, and a typed [[link]] upgrades a suggestion", async () => {
    const auth = await workspace();
    const a = await writeNote(auth, "Skip alpha", "skip a");
    const b = await writeNote(auth, "Skip beta", "skip b");
    const provider = fakeProvider({ "skip a": vec([6]), "skip b": vec([6]) });
    for (const n of [a, b]) await embedArtifact(auth, { artifactId: n.id, provider });
    expect(await materializeSemanticEdges(auth, b.id)).toBe(1);
    expect(await materializeSemanticEdges(auth, b.id)).toBe(1);
    await autosaveNoteDraft(auth, { artifactId: a.id, expectedVersion: 2, content: { type: "doc", content: [] }, plainText: "skip a\n\nSee [[Skip beta]]." });
    const rows = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.workspaceId, auth.workspaceId));
    expect(rows.filter((r) => r.linkType === "reference")).toHaveLength(1);
    expect(await materializeSemanticEdges(auth, b.id)).toBe(0);
  });

  it("tying two cards on the canvas creates one related edge, and combining makes a zettel with lineage", async () => {
    const auth = await workspace();
    const a = await writeNote(auth, "Idea A", "a");
    const b = await writeNote(auth, "Idea B", "b");
    await linkCards(auth, { artifactId: a.id, targetId: b.id });
    await linkCards(auth, { artifactId: b.id, targetId: a.id });
    const graph = await listCardGraph(auth);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges.filter((e) => e.linkType === "related")).toHaveLength(1);

    const merged = await synthesizeZettel(auth, { sourceIds: [a.id, b.id], title: "A meets B" });
    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, merged.id));
    expect(card.kind).toBe("zettel");
    const opened = await getNote(auth, merged.id);
    expect((opened?.content as { format?: string; text?: string }).format).toBe("markdown");
    expect((opened?.content as { text?: string }).text).toContain("Idea A");
    expect((await listNoteOutlinks(auth, merged.id)).map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
    expect((await listNoteBacklinks(auth, a.id)).map((l) => l.id)).toContain(merged.id);
    await expect(synthesizeZettel(auth, { sourceIds: [a.id] })).rejects.toThrow("at least two");
  });

  it("curating links: name the relation and why, reject a suggestion for good, remove a link, notes untouched", async () => {
    const auth = await workspace();
    const a = await writeNote(auth, "Claim", "c");
    const b = await writeNote(auth, "Evidence", "e");
    const c = await writeNote(auth, "Noise", "n");
    const provider = fakeProvider({ c: vec([7]), e: vec([7]), n: vec([7]) });
    for (const n of [a, b, c]) await embedArtifact(auth, { artifactId: n.id, provider });

    // Reject a suggestion: it leaves the panel and a re-embed does not bring it back.
    expect((await relatedNotes(auth, a.id)).map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
    expect(await dismissSemanticLink(auth, { artifactId: a.id, targetId: c.id })).toBe(true);
    await embedArtifact(auth, { artifactId: a.id, provider });
    await embedArtifact(auth, { artifactId: c.id, provider });
    expect((await relatedNotes(auth, a.id)).map((r) => r.id)).toEqual([b.id]);
    expect((await listNoteOutlinks(auth, a.id)).map((l) => l.id)).not.toContain(c.id);

    // Accept, then say what it means and why.
    await linkCards(auth, { artifactId: a.id, targetId: b.id });
    await setLinkRelation(auth, { artifactId: a.id, targetId: b.id, linkType: "supports", why: "b measures the claim" });
    const [out] = await listNoteOutlinks(auth, a.id);
    expect(out).toMatchObject({ id: b.id, linkType: "supports", context: "b measures the claim" });
    expect((await listNoteBacklinks(auth, b.id))[0]).toMatchObject({ id: a.id, linkType: "supports" });

    // Remove the link; both notes remain.
    await removeLink(auth, { artifactId: b.id, targetId: a.id });
    expect(await listNoteOutlinks(auth, a.id)).toEqual([]);
    expect((await listCardGraph(auth)).nodes).toHaveLength(3);
    await expect(removeLink(auth, { artifactId: a.id, targetId: b.id })).rejects.toThrow();

    // Tying a rejected pair again is a fresh decision.
    await linkCards(auth, { artifactId: a.id, targetId: c.id });
    expect((await listNoteOutlinks(auth, a.id)).map((l) => l.id)).toEqual([c.id]);
  });
});
