import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 23: source staleness. When a document's extraction is replaced, ideas
 * decomposed from it learn that their source changed: a namespaced metadata
 * merge stamps sourceChangedAt without touching updated_at (a stale idea must
 * not jump to the top of a recency-sorted list), and the debt report counts
 * the stale ideas so the backlog is visible.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { markDerivedIdeasStale } from "@/domains/knowledge/staleness";
import { getKnowledgeDebt } from "@/domains/knowledge/debt";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const workspace = async () => {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `stale-${crypto.randomUUID()}`);
  return ownerAuth(userId, workspaceId);
};

async function ideaUnder(workspaceId: string, documentId: string): Promise<string> {
  const db = holder.db!;
  // metadata written with bloom must survive the staleness merge (plan test 3).
  const [row] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "zettel", title: "Derived idea", metadata: { bloom: { suggestions: [] } } })
    .returning({ id: artifacts.id });
  await db
    .insert(artifactLinks)
    .values({ workspaceId, artifactId: row.id, targetType: "document", targetId: documentId, linkType: "source" });
  return row.id;
}

const artifactRow = async (id: string) => {
  const [row] = await holder
    .db!.select({
      id: artifacts.id,
      metadata: sql<Record<string, unknown> | null>`${artifacts.metadata}`,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .where(eq(artifacts.id, id));
  return row;
};

suite("source staleness (real Postgres)", () => {
  it("marks derived ideas stale without touching updated_at", async () => {
    const auth = await workspace();
    const [doc] = await holder
      .db!.insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "Source document" })
      .returning({ id: documents.id });
    const ideaId = await ideaUnder(auth.workspaceId, doc.id);
    const before = await artifactRow(ideaId);
    const marked = await markDerivedIdeasStale(auth, { documentId: doc.id });
    const after = await artifactRow(ideaId);
    expect(marked).toBe(1);
    expect(after?.metadata?.sourceChangedAt).toBeDefined();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("counts stale ideas in the debt report", async () => {
    const auth = await workspace();
    const [doc] = await holder
      .db!.insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "Source document" })
      .returning({ id: documents.id });
    await ideaUnder(auth.workspaceId, doc.id);
    await markDerivedIdeasStale(auth, { documentId: doc.id });
    expect((await getKnowledgeDebt(auth)).staleIdeas.total).toBe(1);
  });

  it("leaves an idea's other metadata keys intact", async () => {
    const auth = await workspace();
    const [doc] = await holder
      .db!.insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "Source document" })
      .returning({ id: documents.id });
    const ideaId = await ideaUnder(auth.workspaceId, doc.id);
    await markDerivedIdeasStale(auth, { documentId: doc.id });
    expect((await artifactRow(ideaId))?.metadata?.bloom).toBeDefined();
  });
});
