import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The idea modal's server read path: a card deep-linked by `?idea=<id>` must
 * resolve no matter which page of the collection the reader is on, its links
 * read merged (explicit edges first, semantic neighbours after, duplicates
 * dropped), and a card from another workspace reads as the modal's honest
 * not-found rather than leaking.
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
import { artifactLinks } from "@/domains/knowledge/schema";
import { commitNoteSnapshot, createNote, getNote, listNoteSources } from "@/domains/knowledge/notes";
import { linkCards, linkedNotes, mergeIdeaLinks, relatedNotes } from "@/domains/knowledge/relations";
import { pageZettelCards } from "@/domains/knowledge/zettels";

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

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

type Auth = ReturnType<typeof ownerAuth>;
const workspace = async () => {
  const seed = await seedWorkspace(holder.db!, `im-${crypto.randomUUID()}`);
  return ownerAuth(seed.userId, seed.workspaceId);
};

async function writeCard(auth: Auth, title: string, text: string) {
  const note = await createNote(auth, { title, idempotencyKey: crypto.randomUUID(), kind: "zettel" });
  await commitNoteSnapshot(auth, {
    artifactId: note.id,
    expectedVersion: 1,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    plainText: text,
  });
  return note;
}

suite("the ideas modal read path (real Postgres)", () => {
  it("a deep-linked card resolves from any page position of the collection", async () => {
    const auth = await workspace();
    await writeCard(auth, "First", "first body");
    await writeCard(auth, "Second", "second body");
    const third = await writeCard(auth, "Third", "third body");

    const page = await pageZettelCards(auth, { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items.map((c) => c.title)).toEqual(["Third", "Second"]);

    // The modal fetches the selected card directly, so a deep link to the
    // card left off page one still opens it.
    const selected = await getNote(auth, third.id);
    expect(selected).not.toBeNull();
    expect(selected?.title).toBe("Third");
    expect(await listNoteSources(auth, third.id)).toEqual([]);
  });

  it("a card's links read merged: explicit first, semantic after, duplicates dropped", async () => {
    const auth = await workspace();
    const a = await writeCard(auth, "Anchor", "anchor body");
    const b = await writeCard(auth, "Tied", "tied body");
    const c = await writeCard(auth, "Near", "near body");
    const provider = fakeProvider({ "anchor body": vec([2]), "tied body": vec([2]), "near body": vec([2]) });
    for (const n of [a, b, c]) await embedArtifact(auth, { artifactId: n.id, provider });

    await linkCards(auth, { artifactId: a.id, targetId: b.id });

    const merged = mergeIdeaLinks(await linkedNotes(auth, a.id), await relatedNotes(auth, a.id));
    // b is both explicit and semantic — it appears once, from the explicit half.
    expect(merged.map((r) => r.id)).toEqual([b.id, c.id]);
    expect(merged[0].alreadyLinked).toBe(true);
    expect(merged[1].alreadyLinked).toBe(false);
  });

  it("a legacy dismissed row stays a veto tombstone: it never reads as a linked idea", async () => {
    const auth = await workspace();
    const a = await writeCard(auth, "Anchor", "anchor body");
    const vetoed = await writeCard(auth, "Vetoed", "vetoed body");
    // The dismiss writer is gone; this row is legacy data that predates the
    // state machine's removal. It must not resurface as a link.
    await holder.db!.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: a.id,
      targetType: "artifact",
      targetId: vetoed.id,
      linkType: "dismissed",
    });

    expect((await linkedNotes(auth, a.id)).map((r) => r.id)).toEqual([]);
    expect((await relatedNotes(auth, a.id)).map((r) => r.id)).toEqual([]);
  });

  it("another workspace's id reads as the modal's not-found", async () => {
    const auth = await workspace();
    const other = await workspace();
    const foreign = await writeCard(other, "Foreign", "foreign body");

    expect(await getNote(auth, foreign.id)).toBeNull();
    expect(await relatedNotes(auth, foreign.id)).toEqual([]);
  });
});
