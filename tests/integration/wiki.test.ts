import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WikiSummarizer } from "@/integrations/wiki/summarizer";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

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

import { getWikiOverview, ingestDocument, lintWiki, WikiError } from "@/domains/knowledge/wiki";
import { artifacts, artifactVersions, documents, documentExtractions, wikiPages } from "@/domains/knowledge/schema";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

/** Deterministic summarizer: no provider, the test controls every word. */
function fakeSummarizer(over?: Partial<{ title: string; summary: string; body: string; topics: string[] }>): WikiSummarizer {
  return {
    name: "fake:test",
    async summarize() {
      return {
        title: over?.title ?? "The Lease",
        summary: over?.summary ?? "Rent is twelve hundred a month.",
        body: over?.body ?? "# The Lease\n\nRent is twelve hundred a month.\n",
        topics: over?.topics ?? ["housing"],
      };
    },
  };
}

async function seedDocument(workspaceId: string, title: string, text: string, hash?: string) {
  const db = handle!.db;
  const [doc] = await db.insert(documents).values({ workspaceId, title }).returning();
  const [ext] = await db
    .insert(documentExtractions)
    .values({ workspaceId, documentId: doc.id, contentHash: hash ?? crypto.randomUUID(), status: "succeeded", text })
    .returning();
  return { doc, ext };
}

suite("wiki", { timeout: 30_000 }, () => {
  it("first ingest builds the skeleton, the article, the hub, the index and the log", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-first-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const { doc } = await seedDocument(a.workspaceId, "lease.pdf", "The tenant pays monthly rent. ".repeat(20));

    const result = await ingestDocument(auth, { documentId: doc.id, summarizer: fakeSummarizer() });
    expect(result.changed).toBe(true);
    expect(result.topics).toEqual(["housing"]);

    const db = handle!.db;
    const pages = await db.select().from(wikiPages).where(eq(wikiPages.workspaceId, a.workspaceId));
    const roles = pages.map((p) => p.role).sort();
    expect(roles).toEqual(["article", "index", "log", "topic"]);

    const overview = await getWikiOverview(auth);
    expect(overview?.indexText).toContain("housing");
    expect(overview?.indexText).toContain("1 article");
    expect(overview?.topics[0]?.slug).toBe("housing");
    expect(overview?.articles[0]?.title).toBe("The Lease");
    expect(overview?.logTail.some((l) => l.includes('ingested "The Lease"'))).toBe(true);
  });

  it("re-ingesting unchanged text writes nothing new; a re-extraction appends a version", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-reingest-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const { doc } = await seedDocument(a.workspaceId, "lease.pdf", "text v1", "hash-v1");

    await ingestDocument(auth, { documentId: doc.id, summarizer: fakeSummarizer() });
    const again = await ingestDocument(auth, { documentId: doc.id, summarizer: fakeSummarizer() });
    expect(again.changed).toBe(false);

    const db = handle!.db;
    let versions = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, again.artifactId));
    expect(versions).toHaveLength(1);

    // A newer extraction of the same document appends version 2; version 1 is kept.
    await handle!.db
      .insert(documentExtractions)
      .values({ workspaceId: a.workspaceId, documentId: doc.id, contentHash: "hash-v2", status: "succeeded", text: "text v2" });
    const updated = await ingestDocument(auth, {
      documentId: doc.id,
      summarizer: fakeSummarizer({ body: "# The Lease\n\nUpdated body.\n" }),
    });
    expect(updated.changed).toBe(true);
    versions = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, again.artifactId));
    expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, again.artifactId));
    const current = versions.find((v) => v.id === artifact.currentVersionId);
    expect(current?.plainText).toContain("Updated body.");
  });

  it("an explicit topic override wins over the summarizer's topics", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-topics-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const { doc } = await seedDocument(a.workspaceId, "visa.pdf", "H-1B grace period. ".repeat(20));
    const result = await ingestDocument(auth, { documentId: doc.id, topics: ["job-search"], summarizer: fakeSummarizer() });
    expect(result.topics).toEqual(["job-search"]);
    const overview = await getWikiOverview(auth);
    expect(overview?.topics.map((t) => t.slug)).toEqual(["job-search"]);
  });

  it("a foreign or unknown document fails and writes nothing", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-foreign-a-${Date.now()}`);
    const b = await seedWorkspace(handle!.db, `wiki-foreign-b-${Date.now()}`);
    const { doc } = await seedDocument(a.workspaceId, "secret.pdf", "secret text");
    await expect(
      ingestDocument({ userId: b.userId, workspaceId: b.workspaceId, role: "owner" as const }, { documentId: doc.id, summarizer: fakeSummarizer() }),
    ).rejects.toBeInstanceOf(WikiError);
    const pages = await handle!.db.select().from(wikiPages).where(eq(wikiPages.workspaceId, b.workspaceId));
    expect(pages).toHaveLength(0);
  });

  it("a document with no succeeded extraction cannot be ingested", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-noext-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const [doc] = await handle!.db.insert(documents).values({ workspaceId: a.workspaceId, title: "unread.pdf" }).returning();
    await expect(ingestDocument(auth, { documentId: doc.id, summarizer: fakeSummarizer() })).rejects.toMatchObject({ code: "no_extraction" });
  });

  it("lint reports an archived source and an empty topic, and never fixes them", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-lint-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const { doc } = await seedDocument(a.workspaceId, "lease.pdf", "text");
    await ingestDocument(auth, { documentId: doc.id, summarizer: fakeSummarizer() });
    expect(await lintWiki(auth)).toEqual([]);

    await handle!.db.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, doc.id));
    // An empty topic: registered, but no article points at it anymore.
    await handle!.db.insert(artifacts).values({ workspaceId: a.workspaceId, title: "Topic: ghost", status: "generated" }).returning();
    const [ghostArtifact] = await handle!.db
      .insert(artifacts)
      .values({ workspaceId: a.workspaceId, title: "Topic: ghost2", status: "generated" })
      .returning();
    await handle!.db.insert(wikiPages).values({ workspaceId: a.workspaceId, role: "topic", topicSlug: "ghost", artifactId: ghostArtifact.id });

    const findings = await lintWiki(auth);
    const codes = findings.map((f) => f.code).sort();
    expect(codes).toEqual(["empty_topic", "source_archived"]);
    // Read-only: the rows are all still there.
    const pages = await handle!.db.select().from(wikiPages).where(eq(wikiPages.workspaceId, a.workspaceId));
    expect(pages.length).toBeGreaterThan(0);
  });

  it("a second workspace's wiki is unaffected by the first", async () => {
    const a = await seedWorkspace(handle!.db, `wiki-iso-a-${Date.now()}`);
    const b = await seedWorkspace(handle!.db, `wiki-iso-b-${Date.now()}`);
    const { doc } = await seedDocument(a.workspaceId, "lease.pdf", "text");
    await ingestDocument({ userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const }, { documentId: doc.id, summarizer: fakeSummarizer() });
    const overviewB = await getWikiOverview({ userId: b.userId, workspaceId: b.workspaceId, role: "owner" as const });
    expect(overviewB).toBeNull();
  });
});
