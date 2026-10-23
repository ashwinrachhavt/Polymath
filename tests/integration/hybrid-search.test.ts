import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, messages, threads } from "@/domains/agents/schema";
import { artifacts } from "@/domains/knowledge/schema";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * One retrieval layer: keyword + meaning fused by reciprocal rank, over the
 * one artifact store, including conversations projected as transcripts.
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

import { embedArtifact } from "@/domains/knowledge/embedding";
import { commitNoteSnapshot, createNote } from "@/domains/knowledge/notes";
import { countMeaningUncovered, fuse, searchKnowledge } from "@/domains/knowledge/retrieval";
import { syncThreadToGraph } from "@/domains/knowledge/thread-graph";

function vec(dims: number[]): number[] {
  const v = new Array(1536).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
}
/** Maps a text to a concept direction, so "meaning" is controllable. */
const provider = (concepts: Record<string, number[]>): EmbeddingProvider => ({
  model: "fake@1",
  embed: async (values) => values.map((t) => {
    const hit = Object.entries(concepts).find(([k]) => t.toLowerCase().includes(k));
    return hit ? hit[1] : vec([900]);
  }),
});

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `hs-${crypto.randomUUID()}`), role: "owner" as const });
type Auth = Awaited<ReturnType<typeof workspace>>;

async function write(auth: Auth, title: string, text: string, p?: EmbeddingProvider, kind: "note" | "zettel" = "note") {
  const note = await createNote(auth, { title, kind });
  await commitNoteSnapshot(auth, { artifactId: note.id, expectedVersion: 1, content: { format: "markdown", text }, plainText: text });
  if (p) await embedArtifact(auth, { artifactId: note.id, provider: p });
  return note;
}

describe("fuse (pure)", () => {
  it("rewards agreement between legs over a single strong leg", () => {
    const out = fuse([{ id: "a" }, { id: "b" }], [{ id: "b", distance: 0.2 }, { id: "c", distance: 0.3 }]);
    expect(out.map((o) => o.id)).toEqual(["b", "a", "c"]);
    expect(out[0]).toMatchObject({ kw: 2, mn: 1 });
  });
});

suite("hybrid search (real Postgres)", () => {
  it("finds by keyword, by a typo in the title, and explains why", async () => {
    const auth = await workspace();
    await write(auth, "Compound interest", "Money grows on its own earnings over time.");
    await write(auth, "Sourdough starter", "Flour, water and patience.");
    const exact = await searchKnowledge(auth, { query: "earnings", mode: "keyword" });
    expect(exact.hits[0].title).toBe("Compound interest");
    expect(exact.hits[0].why.keywordRank).toBe(1);
    expect(exact.hits[0].snippet).toContain("[[earnings]]");
    // Freshness is visible: every hit carries the artifact's last edit time.
    expect(exact.hits[0].updatedAt).toBeInstanceOf(Date);
    const typo = await searchKnowledge(auth, { query: "sourdogh", mode: "keyword" });
    expect(typo.hits[0].title).toBe("Sourdough starter");
    expect(typo.hits[0].why.titleMatch).toBe(true);
  });

  it("finds an idea with no shared words through the meaning leg, and hybrid keeps both", async () => {
    const auth = await workspace();
    const p = provider({ money: vec([1]), loaf: vec([2]), "saving": vec([1]) });
    await write(auth, "Compound interest", "Money grows on its own earnings.", p);
    await write(auth, "Bread", "A loaf needs time.", p);
    const res = await searchKnowledge(auth, { query: "saving", provider: p });
    expect(res.meaning).toBe("ok");
    expect(res.hits[0].title).toBe("Compound interest");
    expect(res.hits[0].why.meaningRank).toBe(1);
    expect(res.hits[0].why.similarity).toBeGreaterThan(0.9);
    expect(res.hits.map((h) => h.title)).not.toContain("Bread");
  });

  it("falls back to keyword alone when no provider is configured", async () => {
    const auth = await workspace();
    await write(auth, "Stoicism", "Control what you can.");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await searchKnowledge(auth, { query: "stoicism" });
    expect(res.meaning).toBe("unconfigured");
    expect(res.hits[0].title).toBe("Stoicism");
    vi.unstubAllEnvs();
  });

  it("never crosses a workspace boundary", async () => {
    const a = await workspace();
    const b = await workspace();
    await write(a, "Private idea", "shared word zeppelin");
    expect((await searchKnowledge(b, { query: "zeppelin", mode: "keyword" })).hits).toEqual([]);
  });

  it("projects a whole conversation as one searchable transcript node, once", async () => {
    const auth = await workspace();
    const db = holder.db!;
    const [profile] = await db.insert(agentProfiles).values({ workspaceId: auth.workspaceId, name: `p-${crypto.randomUUID()}`, allowedTools: [] }).returning();
    const [thread] = await db.insert(threads).values({ workspaceId: auth.workspaceId, agentProfileId: profile.id, title: "Pricing chat" }).returning();
    await db.insert(messages).values([
      { workspaceId: auth.workspaceId, threadId: thread.id, role: "user", content: "How should we price the annual plan?" },
      { workspaceId: auth.workspaceId, threadId: thread.id, role: "assistant", content: "Anchor on two months free for annual billing." },
    ]);
    const first = await syncThreadToGraph(auth, thread.id);
    expect(first.created).toBe(true);
    await db.insert(messages).values({ workspaceId: auth.workspaceId, threadId: thread.id, role: "user", content: "And the discount for nonprofits?" });
    const second = await syncThreadToGraph(auth, thread.id);
    expect(second).toEqual({ artifactId: first.artifactId, created: false });
    const res = await searchKnowledge(auth, { query: "nonprofits", mode: "keyword", kinds: ["transcript"] });
    expect(res.hits.map((h) => h.id)).toEqual([first.artifactId]);
    expect(res.hits[0].kind).toBe("transcript");
  });
});

suite("search filters (real Postgres)", () => {
  it("kind restricts both legs, and an unknown kind matches nothing instead of reaching SQL", async () => {
    const auth = await workspace();
    await write(auth, "Keyword note", "zephyr across the sky");
    await write(auth, "Keyword zettel", "zephyr across the sky", undefined, "zettel");
    const zettels = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", kinds: ["zettel"] });
    expect(zettels.hits.map((h) => h.title)).toEqual(["Keyword zettel"]);
    // Kinds are interpolated into SQL: a bogus kind must be rejected, not passed through.
    const bogus = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", kinds: ["note; drop table artifacts--"] });
    expect(bogus.hits).toEqual([]);
  });

  it("from/to bound the last edit (updated_at) on the keyword and meaning legs alike", async () => {
    const auth = await workspace();
    const p = provider({ zephyr: vec([1]) });
    const fresh = await write(auth, "Fresh zephyr", "zephyr today", p);
    const stale = await write(auth, "Stale zephyr", "zephyr long ago", p);
    await holder.db!.update(artifacts).set({ updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) }).where(eq(artifacts.id, stale.id));
    const week = await searchKnowledge(auth, { query: "zephyr", provider: p, filters: { from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } });
    expect(week.hits.map((h) => h.title)).toEqual(["Fresh zephyr"]);
    const beforeYesterday = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", filters: { to: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    expect(beforeYesterday.hits.map((h) => h.title)).toEqual(["Stale zephyr"]);
    expect(fresh.id).not.toBe(stale.id);
  });

  it("provenance is generation provenance exactly: produced_by_run_id set or null", async () => {
    const auth = await workspace();
    const human = await write(auth, "Handwritten zephyr", "zephyr by hand");
    const generated = await write(auth, "Generated zephyr", "zephyr by run");
    await holder.db!.update(artifacts).set({ producedByRunId: crypto.randomUUID() }).where(eq(artifacts.id, generated.id));
    const agentOnly = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", filters: { provenance: "agent" } });
    expect(agentOnly.hits.map((h) => h.title)).toEqual(["Generated zephyr"]);
    const notAgent = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", filters: { provenance: "not-agent" } });
    expect(notAgent.hits.map((h) => h.title)).toEqual(["Handwritten zephyr"]);
    expect(human.id).not.toBe(generated.id);
  });

  it("areaTags are the area dimension's artifact linkage: any declared tag matches, normalized", async () => {
    const auth = await workspace();
    const inArea = await write(auth, "Training zephyr", "zephyr training log");
    const alsoIn = await write(auth, "Nutrition zephyr", "zephyr nutrition");
    await write(auth, "Budget zephyr", "zephyr budget");
    await holder.db!.update(artifacts).set({ tags: ["health"] }).where(eq(artifacts.id, inArea.id));
    await holder.db!.update(artifacts).set({ tags: ["training-log"] }).where(eq(artifacts.id, alsoIn.id));
    // An area declared as {health, training-log} covers both tagged notes; the
    // untagged one stays out. Case and whitespace are normalized to the stored
    // lowercase form.
    const hits = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", filters: { areaTags: ["Health", " training-log "] } });
    expect(hits.hits.map((h) => h.title).sort()).toEqual(["Nutrition zephyr", "Training zephyr"]);
    // An area with no usable tags filters nothing rather than matching nothing.
    const all = await searchKnowledge(auth, { query: "zephyr", mode: "keyword", filters: { areaTags: [" ", ""] } });
    expect(all.hits).toHaveLength(3);
    // The coverage count honors the same predicate set: one uncovered note in
    // the health area, three unfiltered (none of the three embedded).
    expect(await countMeaningUncovered(auth, { filters: { areaTags: ["health"] } })).toBe(1);
    expect(await countMeaningUncovered(auth, {})).toBe(3);
  });

  it("counts exactly what the meaning leg cannot see, with the same kinds, filters and tenant scope", async () => {
    const auth = await workspace();
    const other = await workspace();
    const p = provider({ zephyr: vec([1]) });
    // Covered: embedded at the current version.
    await write(auth, "Covered zephyr", "zephyr indexed fine", p);
    // Failed: the auto-embed has no real key, so embed_error is set and no
    // current-version rows exist.
    await write(auth, "Failed zephyr", "zephyr failed to index");
    // Pending: a real failure record cleared - text, no embedding, no error.
    const pending = await write(auth, "Pending zephyr", "zephyr never attempted");
    await holder.db!.update(artifacts).set({ embedError: null }).where(eq(artifacts.id, pending.id));
    // Empty text is skipped by design: nothing to index, never counted.
    await createNote(auth, { title: "Blank zephyr", kind: "note" });
    expect(await countMeaningUncovered(auth, {})).toBe(2);
    expect(await countMeaningUncovered(auth, { kinds: ["zettel"] })).toBe(0);
    // Same filters as the search: excluding both uncovered notes zeroes the count.
    expect(await countMeaningUncovered(auth, { filters: { to: new Date(Date.now() - 1000) } })).toBe(0);
    // Tenant scope: the other workspace never sees these.
    expect(await countMeaningUncovered(other, {})).toBe(0);
  });

  it("stale chunks after an edit do not rank, and the artifact reads as uncovered", async () => {
    const auth = await workspace();
    const p = provider({ zephyr: vec([1]) });
    const note = await write(auth, "Shifting note", "zephyr first draft", p);
    // Control: the current-version chunk ranks before the edit.
    const before = await searchKnowledge(auth, { query: "zephyr", mode: "meaning", provider: p });
    expect(before.hits.map((h) => h.title)).toContain("Shifting note");
    // Edit: v2 commits, the auto-embed fails without a real key, v1 chunks go stale.
    await commitNoteSnapshot(auth, { artifactId: note.id, expectedVersion: 2, content: { format: "markdown", text: "entirely ordinary replacement words" }, plainText: "entirely ordinary replacement words" });
    const after = await searchKnowledge(auth, { query: "zephyr", mode: "meaning", provider: p });
    expect(after.hits.map((h) => h.title)).not.toContain("Shifting note");
    expect(await countMeaningUncovered(auth, {})).toBe(1);
  });
});
