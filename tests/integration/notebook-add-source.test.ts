import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The notebook Sources pane's mutation surface against real Postgres: a pasted
 * URL captures and attaches to the notebook in one action; a YouTube link
 * queues and still binds by address; a Vault pick reuses the ingested
 * document; and every write is workspace-scoped. The network is stubbed at
 * safeFetch and the transcript fetcher - no test touches a live site.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: {
  db: ReturnType<typeof drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = { db: undefined, auth: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => {
    if (!holder.auth) throw new Error("no auth seeded");
    return holder.auth;
  }),
}));
vi.mock("@/integrations/object-store/object-store", () => ({
  readBlob: vi.fn(async () => new Uint8Array([1])),
  putBlob: vi.fn(async (input: { bytes: Uint8Array; filename: string; contentHash: string }) => ({
    storageKey: `private/${input.contentHash}`,
    contentHash: input.contentHash,
    sizeBytes: input.bytes.byteLength,
  })),
}));
// safeFetch is the network boundary for URL capture; stub it so a pasted link
// resolves deterministically and no test reaches a live site.
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch: (url: string, options?: unknown) => safeFetch(url, options),
}));

import { blobObjects, outboxEvents } from "@/domains/audit/schema";
import { documentExtractions, documents, files, sources } from "@/domains/knowledge/schema";
import { attachToNotebookAction, addUrlToNotebookAction, retryNotebookSourceAction } from "@/app/(workspace)/projects/[projectId]/notebook/add-source-actions";
import { createProject, projectDocumentIds } from "@/domains/knowledge/projects";

let db: NonNullable<typeof handle>["db"];
let projectId: string;
let otherWorkspaceDossierId: string;

beforeAll(async () => {
  if (!handle) return;
  db = handle.db;
  holder.db = db;
  const a = await seedWorkspace(db, `nbadd-${Date.now()}`);
  holder.auth = { ...a, role: "owner" };
  projectId = (await createProject(holder.auth, { name: "Notebook", documentIds: [] })).id;
  // A second workspace proves the scoping checks.
  const b = await seedWorkspace(db, `nbadd-b-${Date.now()}`);
  const savedAuth = holder.auth;
  holder.auth = { ...b, role: "owner" };
  otherWorkspaceDossierId = (await createProject(holder.auth, { name: "Elsewhere", documentIds: [] })).id;
  holder.auth = savedAuth;
});

afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });

suite("notebook add-source actions (real Postgres)", () => {
  it("capturing a URL creates the document, its source row, and the notebook binding", async () => {
    const url = `https://example.com/page-${crypto.randomUUID()}`;
    safeFetch.mockResolvedValue({
      ok: true as const,
      bytes: new TextEncoder().encode("# The page\n\nReadable text."),
      finalUrl: url,
      contentType: "text/html",
    });
    const out = await addUrlToNotebookAction({ projectId, url });
    expect(out.ok).toBe(true);

    const [doc] = await db.select().from(documents)
      .where(eq(documents.sourceUrl, url));
    expect(doc).toBeTruthy();
    expect(doc.fileId).not.toBeNull();
    // The source row exists and binds through the join the pane reads.
    const [source] = await db.select().from(sources).where(eq(sources.url, url));
    expect(source).toBeTruthy();
    const bound = await projectDocumentIds(holder.auth!, projectId);
    expect(bound).toContain(doc.id);
  });

  it("a failed fetch states its reason and re-runs the capture on retry", async () => {
    const url = `https://example.com/dead-${crypto.randomUUID()}`;
    safeFetch.mockResolvedValue({ ok: false as const, error: "The site answered with status 500." });
    const out = await addUrlToNotebookAction({ projectId, url });
    expect(out.ok).toBe(false);
    expect(out.message).toBe("The site answered with status 500.");

    // The document row exists with a failed extraction on it: the pane's
    // readiness projection reads it as Failed, and Retry re-runs the capture
    // (a fetch-class failure can never be fixed by re-queueing extraction).
    const [doc] = await db.select().from(documents).where(eq(documents.sourceUrl, url));
    expect(doc).toBeTruthy();
    const [extraction] = await db.select().from(documentExtractions)
      .where(eq(documentExtractions.documentId, doc.id));
    expect(extraction.status).toBe("failed");
    expect(extraction.error).toBe("The site answered with status 500.");

    // The retry fetches again; this time the site answers.
    safeFetch.mockResolvedValue({
      ok: true as const,
      bytes: new TextEncoder().encode("# Recovered\n\nReadable text."),
      finalUrl: url,
      contentType: "text/html",
    });
    const retry = await retryNotebookSourceAction({ projectId, documentId: doc.id });
    expect(retry).toMatchObject({ ok: true, message: "Fetching the source again." });
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.fileId).not.toBeNull();
  });

  it("a retry on a document outside the workspace refuses; a skipped row refuses with nothing to retry", async () => {
    // A foreign document id is not this workspace's, so no outbox row is minted.
    const foreign = await retryNotebookSourceAction({ projectId, documentId: crypto.randomUUID() });
    expect(foreign.ok).toBe(false);

    // A row no reader accepts has nothing behind the button.
    const [blob] = await db.insert(blobObjects).values({
      workspaceId: holder.auth!.workspaceId, storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(), sizeBytes: 1, mimeType: "application/octet-stream",
    }).returning({ id: blobObjects.id });
    const [file] = await db.insert(files).values({
      workspaceId: holder.auth!.workspaceId, blobId: blob.id, filename: "mystery.bin",
    }).returning({ id: files.id });
    const [unknown] = await db.insert(documents).values({
      workspaceId: holder.auth!.workspaceId, title: "Unknown type", fileId: file.id,
      mimeType: "application/octet-stream",
      createdBy: holder.auth!.userId, updatedBy: holder.auth!.userId,
    }).returning({ id: documents.id });
    await db.insert(documentExtractions).values({
      workspaceId: holder.auth!.workspaceId, documentId: unknown.id, contentHash: crypto.randomUUID(),
      status: "skipped", extractor: "docling@1",
    });
    const refused = await retryNotebookSourceAction({ projectId, documentId: unknown.id });
    expect(refused).toMatchObject({ ok: false, message: "No reader accepts this source type. There is nothing to retry." });
  });

  it("a YouTube link queues the transcript job and binds the video to the notebook by address", async () => {
    // A fresh UUID-based id: Date.now()'s leading digits repeat for over a
    // minute, and a colliding address would let the unscoped document lookup
    // below read another run's row.
    const videoId = crypto.randomUUID().replace(/-/g, "").slice(0, 11);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const out = await addUrlToNotebookAction({ projectId, url });
    expect(out.ok).toBe(true);
    const events = await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId));
    expect(events.some((e) => e.topic === "youtube.transcript_requested")).toBe(true);

    // Binding through the join, not just the dossierSources rows: the queued
    // video has no fileId yet, so the address match is what resolves it.
    const bound = await projectDocumentIds(holder.auth!, projectId);
    const [doc] = await db.select().from(documents)
      .where(and(eq(documents.sourceUrl, url), eq(documents.workspaceId, holder.auth!.workspaceId)));
    expect(doc).toBeTruthy();
    expect(doc.fileId).toBeNull();
    expect(bound).toContain(doc.id);
    const [source] = await db.select().from(sources)
      .where(and(eq(sources.url, url), eq(sources.workspaceId, holder.auth!.workspaceId)));
    expect(source).toBeTruthy();
  });

  it("attaching from the Vault reuses the document, and a foreign document fails cleanly", async () => {
    const [doc] = await db.insert(documents).values({
      workspaceId: holder.auth!.workspaceId, title: "Vault pick",
      createdBy: holder.auth!.userId, updatedBy: holder.auth!.userId,
    }).returning({ id: documents.id });
    const out = await attachToNotebookAction({ projectId, documentIds: [doc.id] });
    expect(out.ok).toBe(true);
    // Idempotent second attach says so instead of doubling rows.
    const again = await attachToNotebookAction({ projectId, documentIds: [doc.id] });
    expect(again.ok).toBe(true);
    const foreign = await attachToNotebookAction({ projectId, documentIds: [crypto.randomUUID()] });
    expect(foreign.ok).toBe(false);
  });

  it("a foreign dossier refuses attaches; a retry on a file-backed document enqueues extraction once", async () => {
    // A file-backed document: the retry path re-queues its extraction.
    const [blob] = await db.insert(blobObjects).values({
      workspaceId: holder.auth!.workspaceId, storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(), sizeBytes: 1, mimeType: "application/pdf",
    }).returning({ id: blobObjects.id });
    const [file] = await db.insert(files).values({
      workspaceId: holder.auth!.workspaceId, blobId: blob.id, filename: "retry-me.pdf",
    }).returning({ id: files.id });
    const [doc] = await db.insert(documents).values({
      workspaceId: holder.auth!.workspaceId, title: "Retry me", fileId: file.id,
      mimeType: "application/pdf",
      createdBy: holder.auth!.userId, updatedBy: holder.auth!.userId,
    }).returning({ id: documents.id });
    const foreign = await attachToNotebookAction({ projectId: otherWorkspaceDossierId, documentIds: [doc.id] });
    expect(foreign.ok).toBe(false);
    const before = (await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId))).length;
    const retry = await retryNotebookSourceAction({ projectId, documentId: doc.id });
    expect(retry.ok).toBe(true);
    const after = (await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId))).length;
    expect(after).toBe(before + 1);
    // The dispatch key is per document, not per click: a second click joins
    // the first attempt instead of minting another doomed row.
    const again = await retryNotebookSourceAction({ projectId, documentId: doc.id });
    expect(again.ok).toBe(true);
    const final = (await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId))).length;
    expect(final).toBe(after);
  });
});
