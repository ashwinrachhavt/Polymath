import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifactVersions, artifacts, documentExtractions, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Document-graph projection (spec, Search: "I search ... and see the sources
 * I captured"): one `document` artifact per library document, text from the
 * latest succeeded extraction, source edge back to the document, so captured
 * reference material joins the search index (keyword and meaning legs).
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

import { DocumentNotFoundError, syncDocumentToGraph } from "@/domains/knowledge/document-graph";
import { searchKnowledge } from "@/domains/knowledge/retrieval";

// No embedding provider keys in the sandbox: embedArtifact must fail soft.
beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });

async function seedDocument(workspaceId: string, title: string, text: string | null) {
  const [doc] = await holder.db!.insert(documents).values({ workspaceId, title }).returning({ id: documents.id });
  if (text !== null) {
    await holder.db!.insert(documentExtractions).values({
      workspaceId, documentId: doc.id, contentHash: `h-${crypto.randomUUID()}`, status: "succeeded", text,
    });
  }
  return doc.id;
}

const mirrorOf = async (workspaceId: string, documentId: string) => {
  const [row] = await holder.db!
    .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind, version: artifacts.version, text: artifactVersions.plainText, linkLabel: artifactLinks.label })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(
      eq(artifactLinks.workspaceId, workspaceId),
      eq(artifactLinks.targetType, "document"),
      eq(artifactLinks.targetId, documentId),
      eq(artifactLinks.linkType, "source"),
    ));
  return row;
};

suite("syncDocumentToGraph", () => {
  it("creates one searchable document mirror with a source edge and backfills documents.artifact_id", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `dg-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const documentId = await seedDocument(workspaceId, "Idempotency notes.pdf", "Idempotency keys make retries safe.");

    const { artifactId, created } = await syncDocumentToGraph(auth, documentId);
    expect(created).toBe(true);
    const mirror = await mirrorOf(workspaceId, documentId);
    expect(mirror).toMatchObject({ id: artifactId, title: "Idempotency notes.pdf", kind: "document", text: "Idempotency keys make retries safe.", linkLabel: "Idempotency notes.pdf" });
    const [doc] = await holder.db!.select({ artifactId: documents.artifactId }).from(documents).where(eq(documents.id, documentId));
    expect(doc.artifactId).toBe(artifactId);

    // The whole point: the captured source is found by the one search.
    const result = await searchKnowledge(auth, { query: "idempotency", limit: 10 });
    expect(result.hits.map((h) => h.id)).toContain(artifactId);
    expect(result.hits.find((h) => h.id === artifactId)?.kind).toBe("document");
  });

  it("is a no-op when the text has not changed, a new version when it has", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `dg-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const documentId = await seedDocument(workspaceId, "Spec.pdf", "version one text");
    const first = await syncDocumentToGraph(auth, documentId);

    const again = await syncDocumentToGraph(auth, documentId);
    expect(again).toEqual({ artifactId: first.artifactId, created: false });
    let mirror = await mirrorOf(workspaceId, documentId);
    expect(mirror.version).toBe(1);

    // A later extraction for the same document supersedes the mirror's text.
    await holder.db!.insert(documentExtractions).values({
      workspaceId, documentId, contentHash: `h-${crypto.randomUUID()}`, status: "succeeded", text: "version two text",
    });
    // createdAt ordering: force the newer row to read as latest.
    await holder.db!.update(documentExtractions).set({ createdAt: new Date(Date.now() + 1000) })
      .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.text, "version two text")));
    const resynced = await syncDocumentToGraph(auth, documentId);
    expect(resynced.created).toBe(false);
    mirror = await mirrorOf(workspaceId, documentId);
    expect(mirror.version).toBe(2);
    expect(mirror.text).toBe("version two text");
  });

  it("applies a document rename to the mirror on the next sync", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `dg-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const documentId = await seedDocument(workspaceId, "old-name.pdf", "some text");
    const { artifactId } = await syncDocumentToGraph(auth, documentId);
    await holder.db!.update(documents).set({ title: "new-name.pdf" }).where(eq(documents.id, documentId));
    await syncDocumentToGraph(auth, documentId);
    const [a] = await holder.db!.select({ title: artifacts.title }).from(artifacts).where(eq(artifacts.id, artifactId!));
    expect(a.title).toBe("new-name.pdf");
  });

  it("mirrors nothing when no extraction has succeeded, without erroring", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `dg-${crypto.randomUUID()}`);
    const auth = ownerAuth(userId, workspaceId);
    const failedOnly = await seedDocument(workspaceId, "unreadable.pdf", null);
    await holder.db!.insert(documentExtractions).values({
      workspaceId, documentId: failedOnly, contentHash: `h-${crypto.randomUUID()}`, status: "failed", error: "scanned image",
    });
    const result = await syncDocumentToGraph(auth, failedOnly);
    expect(result).toEqual({ artifactId: null, created: false });
    expect(await mirrorOf(workspaceId, failedOnly)).toBeUndefined();
  });

  it("never touches another workspace's document", async () => {
    const a = await seedWorkspace(holder.db!, `dg-${crypto.randomUUID()}`);
    const b = await seedWorkspace(holder.db!, `dg-${crypto.randomUUID()}`);
    const foreignDoc = await seedDocument(b.workspaceId, "foreign.pdf", "foreign text");
    await expect(syncDocumentToGraph(ownerAuth(a.userId, a.workspaceId), foreignDoc)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});
