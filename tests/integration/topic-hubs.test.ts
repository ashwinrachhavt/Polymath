import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 21: topic hubs. One hub artifact per canonical L1 topic, created
 * lazily and safe under concurrent first use; filing an idea writes a
 * part_of edge; hubs never surface as ideas and never enter the
 * semantic-edge pass in either direction.
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

import { ensureTopicHub, fileIdeaUnderTopic } from "@/domains/knowledge/topic-hubs";
import { materializeSemanticEdges } from "@/domains/knowledge/relations";
import { embedArtifact } from "@/domains/knowledge/embedding";
import { pageZettelCards } from "@/domains/knowledge/zettels";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const workspace = async () => {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `hub-${crypto.randomUUID()}`);
  return ownerAuth(userId, workspaceId);
};

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

/** A note-kind artifact with one version carrying text — the smallest legal idea. */
async function ideaArtifact(workspaceId: string, title: string, text: string): Promise<string> {
  const db = holder.db!;
  const [row] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "zettel", title })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId,
      artifactId: row.id,
      versionNumber: 1,
      content: { type: "doc", content: [] },
      plainText: text,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, row.id));
  return row.id;
}

async function hubCount(workspaceId: string, slug: string): Promise<number> {
  const rows = await holder
    .db!.select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        eq(artifacts.kind, "other"),
        isNull(artifacts.archivedAt),
        sql`${artifacts.metadata}->>'topicHubSlug' = ${slug}`,
      ),
    );
  return rows.length;
}

async function partOfEdges(artifactId: string): Promise<unknown[]> {
  return holder
    .db!.select({ id: artifactLinks.id })
    .from(artifactLinks)
    .where(and(eq(artifactLinks.artifactId, artifactId), eq(artifactLinks.linkType, "part_of")));
}

suite("topic hubs (real Postgres)", () => {
  it("creates one hub per topic under concurrent first use", async () => {
    const auth = await workspace();
    const [a, b] = await Promise.all([
      ensureTopicHub(auth, "coding-development"),
      ensureTopicHub(auth, "coding-development"),
    ]);
    expect(a.id).toBe(b.id);
    expect(await hubCount(auth.workspaceId, "coding-development")).toBe(1);
  });

  it("never appears in the Ideas list", async () => {
    const auth = await workspace();
    await ensureTopicHub(auth, "coding-development");
    const { items } = await pageZettelCards(auth, { limit: 50, offset: 0 });
    expect(items.some((i) => i.title === "Coding & Development")).toBe(false);
  });

  it("files an idea under two topics with two part_of edges", async () => {
    const auth = await workspace();
    const artifactId = await ideaArtifact(auth.workspaceId, "An idea", "idea body text");
    await fileIdeaUnderTopic(auth, { artifactId, topicSlug: "coding-development" });
    await fileIdeaUnderTopic(auth, { artifactId, topicSlug: "research-learning" });
    expect(await partOfEdges(artifactId)).toHaveLength(2);
  });

  it("throws for an unknown or non-L1 slug instead of inventing a label", async () => {
    const auth = await workspace();
    await expect(ensureTopicHub(auth, "llms")).rejects.toThrow(/topic/i);
    await expect(ensureTopicHub(auth, "no-such-topic")).rejects.toThrow(/topic/i);
    expect(await hubCount(auth.workspaceId, "no-such-topic")).toBe(0);
  });

  it("a hub never enters the semantic-edge pass, even with neighbours nearby", async () => {
    const auth = await workspace();
    const neighbourId = await ideaArtifact(auth.workspaceId, "Neighbour", "neighbour body text");
    const hub = await ensureTopicHub(auth, "coding-development");
    // The hub carries the same vector as the neighbour: without the guard this
    // distance-0 pair materializes a semantic edge.
    const provider = fakeProvider({ "neighbour body text": vec([1]), "Coding & Development": vec([1]) });
    await embedArtifact(auth, { artifactId: neighbourId, provider });
    await embedArtifact(auth, { artifactId: hub.id, provider });
    expect(await materializeSemanticEdges(auth, hub.id)).toBe(0);
    const edges = await holder
      .db!.select({ id: artifactLinks.id })
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, hub.id), eq(artifactLinks.linkType, "semantic")));
    expect(edges).toHaveLength(0);
  });

  it("the semantic pass still runs for ordinary notes alongside hubs", async () => {
    const auth = await workspace();
    const a = await ideaArtifact(auth.workspaceId, "First", "first idea body text");
    const b = await ideaArtifact(auth.workspaceId, "Second", "second idea body text");
    await ensureTopicHub(auth, "research-learning");
    const provider = fakeProvider({ "first idea body text": vec([2]), "second idea body text": vec([2]) });
    await embedArtifact(auth, { artifactId: a, provider });
    await embedArtifact(auth, { artifactId: b, provider });
    expect(await materializeSemanticEdges(auth, a)).toBe(1);
    const edges = await holder
      .db!.select({ id: artifactLinks.id })
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, a), eq(artifactLinks.linkType, "semantic")));
    expect(edges).toHaveLength(1);
  });
});
