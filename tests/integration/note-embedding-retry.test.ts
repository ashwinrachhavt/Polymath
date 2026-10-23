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
import { countMeaningUncovered, searchKnowledge } from "@/domains/knowledge/retrieval";

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
});
