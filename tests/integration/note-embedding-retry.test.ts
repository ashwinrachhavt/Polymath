import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The notes-side embedding retry, end to end on real Postgres with a fake
 * provider: a note committed while the provider is unconfigured carries
 * embed_error and is invisible to the meaning leg; retryNoteEmbedding re-runs
 * the same embedArtifact the commit path uses and the note becomes findable.
 * The fake provider proves the WIRING (rows, error state, retrieval leg);
 * the real provider call in production stays the user's own retry action.
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

import { commitNoteSnapshot, createNote, getNote, NoteNotFoundError, retryNoteEmbedding } from "@/domains/knowledge/notes";
import { countMeaningUncovered, countMeaningUncoveredByState, searchKnowledge } from "@/domains/knowledge/retrieval";

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

beforeAll(() => {
  holder.db = handle?.db;
  // The commit path's own best-effort embed must see NO provider, so the
  // failed state under test is the real unconfigured one, not a live key
  // leaked from the developer's shell (which would also make a paid call).
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("EMBEDDING_PROVIDER", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `nr-${crypto.randomUUID()}`), role: "owner" as const });
type Auth = Awaited<ReturnType<typeof workspace>>;

async function writeNote(auth: Auth, title: string, text: string) {
  const note = await createNote(auth, { title, kind: "note" });
  await commitNoteSnapshot(auth, { artifactId: note.id, expectedVersion: 1, content: { format: "markdown", text }, plainText: text });
  return note;
}

suite("note embedding retry (real Postgres)", () => {
  it("a note committed with no provider records the failure, surfaces it, and retries into meaning search", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Sourdough starter", "Flour, water and patience make the fermentation work.");

    // The commit's own embed saw no provider: the failure is recorded, the
    // note is unindexed, and the fleet coverage counter sees it.
    let detail = await getNote(auth, note.id);
    expect(detail?.indexed).toBe(false);
    expect(detail?.embedError).toContain("No embedding provider configured");
    expect(await countMeaningUncovered(auth, {})).toBe(1);

    // Retry with a working provider: same embedArtifact the commit path uses.
    const fake = provider({ fermentation: vec([1]) });
    const out = await retryNoteEmbedding(auth, { artifactId: note.id, provider: fake });
    expect(out).toEqual({ status: "succeeded", chunks: 1 });

    detail = await getNote(auth, note.id);
    expect(detail?.indexed).toBe(true);
    expect(detail?.embedError).toBeNull();
    expect(await countMeaningUncovered(auth, {})).toBe(0);

    // And the meaning leg now finds the note by concept, not by keyword.
    const result = await searchKnowledge(auth, { query: "fermentation", mode: "meaning", provider: fake });
    expect(result.hits.map((h) => h.id)).toContain(note.id);
  });

  it("a retry with no provider configured fails honestly and re-records the reason", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Plain note", "Some committed text.");
    const out = await retryNoteEmbedding(auth, { artifactId: note.id });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.error).toContain("No embedding provider configured");
    const [row] = await holder.db!.select({ embedError: artifacts.embedError }).from(artifacts).where(eq(artifacts.id, note.id));
    expect(row.embedError).toContain("No embedding provider configured");
  });

  it("refuses another workspace's note", async () => {
    const mine = await workspace();
    const other = await workspace();
    const note = await writeNote(mine, "Mine", "Text that is mine alone.");
    await expect(retryNoteEmbedding(other, { artifactId: note.id, provider: provider({}) })).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("skips a note with no committed text instead of pretending to index it", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Empty", "");
    const out = await retryNoteEmbedding(auth, { artifactId: note.id, provider: provider({}) });
    expect(out).toEqual({ status: "skipped", reason: "no_text" });
    const detail = await getNote(auth, note.id);
    expect(detail?.indexed).toBe(false);
  });

  it("rejects a malformed id as not-found, never as a database error", async () => {
    const auth = await workspace();
    await expect(retryNoteEmbedding(auth, { artifactId: "not-a-uuid" })).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("never renders a raw persisted error: a poisoned embed_error maps to the authored generic", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Poisoned", "Text.");
    await holder.db!.update(artifacts).set({
      embedError: "provider 401: token sk-live-abc123; SQL: select * from users; POST /embeddings body={\"input\":\"...\"}",
    }).where(eq(artifacts.id, note.id));
    const detail = await getNote(auth, note.id);
    expect(detail?.embedError).toBe("Indexing failed. Retry to try again.");
    expect(JSON.stringify(detail)).not.toContain("sk-live-abc123");
  });

  it("an edit committed mid-embed wins: stale vectors are not written and the new version keeps its own state", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Race", "First text about fermentation.");
    // Slow provider whose first call waits on a gate we control.
    let entered!: () => void;
    const embedEntered = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: EmbeddingProvider = {
      model: "fake@1",
      embed: async (values) => { entered(); await gate; return values.map(() => vec([1])); },
    };
    const retry = retryNoteEmbedding(auth, { artifactId: note.id, provider: slow });
    await embedEntered; // the pass now holds the advisory lock and is mid-call on v1

    // The user edits and commits v2 while the retry is in flight. The commit
    // itself lands; its own best-effort embed sees the busy lock and bows out.
    const detail1 = await getNote(auth, note.id);
    await commitNoteSnapshot(auth, { artifactId: note.id, expectedVersion: detail1!.version, content: { format: "markdown", text: "Replacement text about brewing." }, plainText: "Replacement text about brewing." });
    release();
    const out = await retry;

    expect(out).toEqual({ status: "skipped", reason: "edited" });
    // No vectors written for the stale v1, and nothing marked on v2: the
    // commit cleared v1's recorded failure (a failure describes the version
    // it ran against; v2 has no recorded pass), and the edited pass wrote
    // nothing.
    const rows = await holder.db!.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, note.id));
    expect(rows).toHaveLength(1);
    const embeddingRows = await holder.db!.execute("select count(*)::int as n from embeddings where owner_id = '" + note.id + "'") as unknown as { n: number }[];
    expect(embeddingRows[0].n).toBe(0);
    const detail = await getNote(auth, note.id);
    expect(detail?.indexed).toBe(false);
    expect(detail?.embedError).toBeNull();
  });

  it("an edit committed mid-failing-pass keeps the old version's failure off the new version", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "RaceFail", "First text about fermentation.");
    // v1 carries a recorded failure from the commit path (no provider).
    let detail = await getNote(auth, note.id);
    expect(detail?.embedError).toContain("No embedding provider configured");

    // A slow pass starts on v1 and fails only after a gate we control.
    let entered!: () => void;
    const embedEntered = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const failing: EmbeddingProvider = {
      model: "fake@1",
      embed: async () => { entered(); await gate; throw new Error("provider down"); },
    };
    const pass = retryNoteEmbedding(auth, { artifactId: note.id, provider: failing });
    await embedEntered;

    // The user edits and commits v2 while the pass is in flight: the commit
    // clears v1's failure (the new version has no recorded pass yet) and its
    // own best-effort embed bows out on the busy lock.
    await commitNoteSnapshot(auth, { artifactId: note.id, expectedVersion: detail!.version, content: { format: "markdown", text: "Replacement text about brewing." }, plainText: "Replacement text about brewing." });
    release();
    const out = await pass;

    // The failed pass ran against v1: its error must NOT land on v2.
    expect(out).toEqual({ status: "skipped", reason: "edited" });
    detail = await getNote(auth, note.id);
    expect(detail?.indexed).toBe(false);
    expect(detail?.embedError).toBeNull();
    // Fleet split: v2 is pending (no pass recorded), not failed.
    expect(await countMeaningUncoveredByState(auth, {})).toEqual({ pending: 1, failed: 0 });
  });

  it("the fleet count separates pending from failed and the total stays their sum", async () => {
    const auth = await workspace();
    // failed: committed with no provider, error recorded, never retried.
    await writeNote(auth, "Failed one", "Text about fermentation that never indexed.");
    // covered: retried into vectors with a working provider.
    const covered = await writeNote(auth, "Covered one", "Text about brewing that gets indexed.");
    const fake = provider({ brewing: vec([2]) });
    expect(await retryNoteEmbedding(auth, { artifactId: covered.id, provider: fake })).toEqual({ status: "succeeded", chunks: 1 });
    // pending: an edit whose own embed is still owed and carries no recorded failure.
    const edited = await writeNote(auth, "Pending one", "First text about fermentation.");
    let entered!: () => void;
    const embedEntered = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: EmbeddingProvider = {
      model: "fake@1",
      embed: async (values) => { entered(); await gate; return values.map(() => vec([1])); },
    };
    const pass = retryNoteEmbedding(auth, { artifactId: edited.id, provider: slow });
    await embedEntered;
    const before = await getNote(auth, edited.id);
    await commitNoteSnapshot(auth, { artifactId: edited.id, expectedVersion: before!.version, content: { format: "markdown", text: "Second text about brewing." }, plainText: "Second text about brewing." });
    release();
    expect(await pass).toEqual({ status: "skipped", reason: "edited" });

    expect(await countMeaningUncoveredByState(auth, {})).toEqual({ pending: 1, failed: 1 });
    expect(await countMeaningUncovered(auth, {})).toBe(2);
  });

  it("a second concurrent pass is told one is already running instead of paying twice", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Busy", "Text about fermentation.");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: EmbeddingProvider = {
      model: "fake@1",
      embed: async (values) => { calls++; await gate; return values.map(() => vec([1])); },
    };
    const first = retryNoteEmbedding(auth, { artifactId: note.id, provider: slow });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await retryNoteEmbedding(auth, { artifactId: note.id, provider: slow });
    expect(second).toEqual({ status: "skipped", reason: "busy" });
    release();
    expect(await first).toEqual({ status: "succeeded", chunks: 1 });
    expect(calls).toBe(1); // the provider was paid once
  });

  it("a hung provider is bounded by the batch timeout and releases the lock and connection", { timeout: 20_000 }, async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Hanging", "Text about fermentation.");
    const hanging: EmbeddingProvider = { model: "fake@1", embed: () => new Promise(() => {}) }; // never resolves
    const started = Date.now();
    const out = await retryNoteEmbedding(auth, { artifactId: note.id, provider: hanging, batchTimeoutMs: 200 });
    expect(out.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000);
    // The transaction committed the failure and released everything: a fresh
    // pass with a working provider indexes immediately (no busy, no hang).
    const fake = provider({ fermentation: vec([1]) });
    expect(await retryNoteEmbedding(auth, { artifactId: note.id, provider: fake })).toEqual({ status: "succeeded", chunks: 1 });
  });

  it("provider failure logging carries no request body or token", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Leaky", "Secret fermentation text.");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const leaky: EmbeddingProvider = {
        model: "fake@1",
        embed: async () => {
          const cause = new Error("401 unauthorized: token sk-live-abc123 body={\"input\":\"Secret fermentation text.\"}");
          (cause as unknown as { statusCode: number }).statusCode = 401;
          throw cause;
        },
      };
      const out = await retryNoteEmbedding(auth, { artifactId: note.id, provider: leaky });
      expect(out.status).toBe("failed");
      const logged = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).toContain("401");
      expect(logged).not.toContain("sk-live-abc123");
      expect(logged).not.toContain("Secret fermentation text");
      const detail = await getNote(auth, note.id);
      expect(detail?.embedError).toBe("Embedding could not complete. Retry to try again.");
    } finally {
      spy.mockRestore();
    }
  });

  it("a twin retry joins an already-indexed version without another provider call", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Twin", "Text about fermentation.");
    const fake = provider({ fermentation: vec([1]) });
    expect(await retryNoteEmbedding(auth, { artifactId: note.id, provider: fake })).toEqual({ status: "succeeded", chunks: 1 });
    const exploding: EmbeddingProvider = { model: "fake@1", embed: async () => { throw new Error("must not be called"); } };
    expect(await retryNoteEmbedding(auth, { artifactId: note.id, provider: exploding })).toEqual({ status: "succeeded", chunks: 1 });
    expect((await getNote(auth, note.id))?.indexed).toBe(true);
  });
});
