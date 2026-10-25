import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Search reveals connections (spec: what supports a hit, what it became part
 * of, with the reason where one is recorded). listHitConnections is the one
 * batched read a results page makes over the link graph for its hits.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { HIT_CONNECTION_CAP, listHitConnections } from "@/domains/knowledge/retrieval";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

async function card(workspaceId: string, title: string, kind: "note" | "zettel" | "document" = "note") {
  const [row] = await holder.db!.insert(artifacts).values({ workspaceId, title, kind }).returning({ id: artifacts.id });
  return row.id;
}

async function link(workspaceId: string, from: string, to: string, linkType: string, targetType = "note", context?: string) {
  await holder.db!.insert(artifactLinks).values({ workspaceId, artifactId: from, targetId: to, targetType, linkType, context: context ?? null });
}

suite("listHitConnections", () => {
  it("returns the source edge with its supporting quote, out references, and backlinks", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const doc = await card(workspaceId, "Reference doc", "document");
    const zettel = await card(workspaceId, "Claim card", "zettel");
    const noteA = await card(workspaceId, "Note A");
    const noteB = await card(workspaceId, "Note B");
    await link(workspaceId, zettel, doc, "source", "document", "The exact passage that supports the claim.");
    await link(workspaceId, zettel, noteA, "reference");
    await link(workspaceId, noteB, zettel, "reference");

    const map = await listHitConnections(auth, [zettel]);
    const c = map.get(zettel)!;
    expect(c.out).toHaveLength(2);
    const source = c.out.find((e) => e.linkType === "source")!;
    expect(source.id).toBe(doc);
    expect(source.title).toBe("Reference doc");
    expect(source.kind).toBe("document");
    expect(source.context).toBe("The exact passage that supports the claim.");
    expect(c.out.some((e) => e.linkType === "reference" && e.id === noteA)).toBe(true);
    expect(c.outTotal).toBe(2);
    expect(c.in).toEqual([expect.objectContaining({ id: noteB, title: "Note B", linkType: "reference" })]);
    expect(c.inTotal).toBe(1);
  });

  it("shows a document hit the zettels distilled from it (in-bound source edges)", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const doc = await card(workspaceId, "Source doc", "document");
    const zettel = await card(workspaceId, "Distilled claim", "zettel");
    await link(workspaceId, zettel, doc, "source", "document", "quote");
    const map = await listHitConnections(auth, [doc]);
    const c = map.get(doc)!;
    expect(c.in).toEqual([expect.objectContaining({ id: zettel, linkType: "source" })]);
    expect(c.out).toHaveLength(0);
  });

  it("excludes semantic and dismissed edges and archived far-side cards", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const hit = await card(workspaceId, "Hit");
    const sem = await card(workspaceId, "Semantic candidate");
    const dis = await card(workspaceId, "Dismissed one");
    const gone = await card(workspaceId, "Archived one");
    await link(workspaceId, hit, sem, "semantic");
    await link(workspaceId, hit, dis, "dismissed");
    await link(workspaceId, hit, gone, "reference");
    await holder.db!.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, gone));

    const c = (await listHitConnections(auth, [hit])).get(hit)!;
    expect(c.out).toHaveLength(0);
    expect(c.outTotal).toBe(0);
  });

  it("never returns another workspace's edges, even pointing at the hit", async () => {
    const a = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const b = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const auth = ownerAuth(a.userId, a.workspaceId);
    const hit = await card(a.workspaceId, "My hit");
    const foreign = await card(b.workspaceId, "Foreign card");
    await link(b.workspaceId, foreign, hit, "reference");
    const c = (await listHitConnections(auth, [hit])).get(hit)!;
    expect(c.in).toHaveLength(0);
    expect(c.inTotal).toBe(0);
  });

  it("caps the display arrays and keeps the full counts", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const hit = await card(workspaceId, "Hub");
    for (let i = 0; i < HIT_CONNECTION_CAP + 2; i++) {
      const target = await card(workspaceId, `Target ${i}`);
      await link(workspaceId, hit, target, "reference");
    }
    const c = (await listHitConnections(auth, [hit])).get(hit)!;
    expect(c.out).toHaveLength(HIT_CONNECTION_CAP);
    expect(c.outTotal).toBe(HIT_CONNECTION_CAP + 2);
  });

  it("batches one page of hits and leaves unconnected hits empty", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `shc-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const a = await card(workspaceId, "A");
    const b = await card(workspaceId, "B");
    const lonely = await card(workspaceId, "Lonely");
    await link(workspaceId, a, b, "reference");
    const map = await listHitConnections(auth, [a, b, lonely]);
    expect(map.get(a)!.out).toHaveLength(1);
    expect(map.get(b)!.in).toHaveLength(1);
    expect(map.get(lonely)).toEqual({ out: [], in: [], outTotal: 0, inTotal: 0 });
    expect((await listHitConnections(auth, [])).size).toBe(0);
  });
});
