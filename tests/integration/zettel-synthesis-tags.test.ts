import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The mix carries its parents with it: a synthesis zettel inherits the union
 * of its parents' tags (normalized — lowercase-deduped, capped at 12), and
 * after the commit the new card joins the semantic graph best-effort, the way
 * acceptZettel does. An embedding failure must never fail a mix that
 * succeeded; the idempotency receipt must survive the extension untouched.
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

// The embed seam is the point of the last test: when the post-commit embed
// pass throws, the mix must still return the card it committed. The
// dispatcher keeps the real implementation for every other test.
const embedSeam = vi.hoisted(() => ({ throwWith: undefined as undefined | Error }));
vi.mock("@/domains/knowledge/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/knowledge/embedding")>();
  return {
    ...actual,
    embedArtifact: async (...args: Parameters<typeof actual.embedArtifact>) => {
      if (embedSeam.throwWith) throw embedSeam.throwWith;
      return actual.embedArtifact(...args);
    },
  };
});

import { synthesizeZettel } from "@/domains/knowledge/notes";

beforeAll(() => {
  holder.db = handle?.db;
  // Keep the post-commit embed unconfigured: the pass records a failure on
  // the card instead of reaching for a real provider, so the tests here
  // exercise the union and the swallow, not a provider.
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

type OwnerAuth = ReturnType<typeof ownerAuth>;

/** A linkable note card carrying tags, seeded straight into the artifact store. */
async function seedTaggedCard(auth: OwnerAuth, title: string, tags: string[]) {
  const [card] = await holder.db!
    .insert(artifacts)
    .values({ workspaceId: auth.workspaceId, kind: "note", title, tags, createdBy: auth.userId, updatedBy: auth.userId })
    .returning({ id: artifacts.id });
  return card.id;
}

async function workspace() {
  const seed = await seedWorkspace(holder.db!, `zsyn-${crypto.randomUUID()}`);
  return ownerAuth(seed.userId, seed.workspaceId);
}

suite("synthesizeZettel carries its parents' tags (real Postgres)", () => {
  it("unions the parents' tags onto the new card, case-duplicates collapsed, parents' order first", async () => {
    const auth = await workspace();
    const a = await seedTaggedCard(auth, "Idea A", ["Rent", " control ", "rent"]);
    const b = await seedTaggedCard(auth, "Idea B", ["CONTROL", "housing"]);

    const mixed = await synthesizeZettel(auth, { sourceIds: [a, b] });

    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, mixed.id));
    expect(card.kind).toBe("zettel");
    expect(card.tags).toEqual(["rent", "control", "housing"]);
  });

  it("caps the union at 12 tags after dedupe, not before", async () => {
    const auth = await workspace();
    const a = await seedTaggedCard(auth, "Dense A", ["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08"]);
    // T05-t08 are case-duplicates of A's; u13 is the thirteenth distinct tag —
    // the cap must cut it, not a duplicate.
    const b = await seedTaggedCard(auth, "Dense B", ["T05", "t06", "t07", "t08", "u09", "u10", "u11", "u12", "u13"]);

    const mixed = await synthesizeZettel(auth, { sourceIds: [a, b] });

    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, mixed.id));
    expect(card.tags).toEqual(["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "u09", "u10", "u11", "u12"]);
    expect(card.tags).not.toContain("u13");
  });

  it("keeps one source edge per parent and replays an idempotency key to the same card", async () => {
    const auth = await workspace();
    const a = await seedTaggedCard(auth, "Parent A", ["alpha"]);
    const b = await seedTaggedCard(auth, "Parent B", ["beta"]);
    const input = { sourceIds: [a, b], idempotencyKey: crypto.randomUUID() };

    const first = await synthesizeZettel(auth, input);
    const replay = await synthesizeZettel(auth, input);

    expect(replay).toEqual(first);
    const edges = await holder.db!
      .select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.workspaceId, auth.workspaceId), eq(artifactLinks.artifactId, first.id), eq(artifactLinks.linkType, "source")));
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.targetId).sort()).toEqual([a, b].sort());
    const cards = await holder.db!
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel"), inArray(artifacts.id, [first.id])));
    expect(cards).toHaveLength(1);
  });

  it("a mix returns the committed card even when the post-commit embed pass throws", async () => {
    const auth = await workspace();
    const a = await seedTaggedCard(auth, "Sole A", ["alpha"]);
    const b = await seedTaggedCard(auth, "Sole B", ["beta"]);

    embedSeam.throwWith = new Error("provider down");
    try {
      const mixed = await synthesizeZettel(auth, { sourceIds: [a, b] });
      const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, mixed.id));
      expect(card.kind).toBe("zettel");
      expect(card.tags).toEqual(["alpha", "beta"]);
      expect(typeof mixed.version).toBe("number");
    } finally {
      embedSeam.throwWith = undefined;
    }
  });
});
