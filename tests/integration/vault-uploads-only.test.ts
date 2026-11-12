import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { blobObjects, outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { documentExtractions, documentFolders, documents, files } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Document Vault is the person's own files (real Postgres): an uploaded
 * document is a vault row and counts toward its folder; a capture filed by
 * Zettelize or Learn, a fetched web page, and a document with no file are
 * library sources, never vault rows. A title stored as markdown reads as
 * plain words. Also proves 0312's data step on live rows, inside a
 * transaction that is rolled back so no other suite sees it.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: NonNullable<ReturnType<typeof makeTestDb>>["db"] } = { db: undefined as never };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

let vault: typeof import("@/domains/knowledge/vault-queries");
let library: typeof import("@/domains/knowledge/library");

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  vault = await import("@/domains/knowledge/vault-queries");
  library = await import("@/domains/knowledge/library");
});
afterAll(async () => {
  await handle?.client.end();
});

type Auth = { userId: string; workspaceId: string; role: "owner" };

async function seed(slug: string): Promise<Auth> {
  const { userId, workspaceId } = await seedWorkspace(holder.db, `vault-${slug}-${Date.now()}`);
  return { userId, workspaceId, role: "owner" };
}

async function addDocument(
  auth: Auth,
  values: { title: string; origin?: string; filename?: string; sourceUrl?: string; folderId?: string },
) {
  let fileId: string | null = null;
  if (values.origin) {
    const [blob] = await holder.db
      .insert(blobObjects)
      .values({
        workspaceId: auth.workspaceId,
        storageKey: `key-${crypto.randomUUID()}`,
        contentHash: `hash-${crypto.randomUUID()}`,
        sizeBytes: 2048,
        mimeType: "application/pdf",
      })
      .returning();
    const [file] = await holder.db
      .insert(files)
      .values({
        workspaceId: auth.workspaceId,
        blobId: blob.id,
        filename: values.filename ?? `${values.title}.pdf`,
        origin: values.origin,
      })
      .returning();
    fileId = file.id;
  }
  const [doc] = await holder.db
    .insert(documents)
    .values({
      workspaceId: auth.workspaceId,
      title: values.title,
      fileId,
      sourceUrl: values.sourceUrl ?? null,
      folderId: values.folderId ?? null,
    })
    .returning();
  return doc;
}

suite("the Document Vault lists uploads only", () => {
  it("shows an uploaded document and leaves out filed captures, web pages and fileless rows", async () => {
    const auth = await seed("only");
    await addDocument(auth, { title: "Lease agreement", origin: "upload" });
    await addDocument(auth, { title: "RAG vs. Jev + RAG", origin: "capture", filename: "RAG vs. Jev + RAG.md" });
    await addDocument(auth, { title: "A crawled page", origin: "crawl", sourceUrl: "https://example.com/a" });
    await addDocument(auth, { title: "A fetched link", sourceUrl: "https://example.com/b" });

    const rows = await vault.getVaultDocuments(auth, null);
    expect(rows.map((row) => row.title)).toEqual(["Lease agreement"]);
  });

  it("counts only uploads toward a folder", async () => {
    const auth = await seed("folder");
    const [folder] = await holder.db
      .insert(documentFolders)
      .values({ workspaceId: auth.workspaceId, name: "Taxes", createdBy: auth.userId })
      .returning();
    await addDocument(auth, { title: "W-2", origin: "upload", folderId: folder.id });
    await addDocument(auth, { title: "Filed capture", origin: "capture", folderId: folder.id });

    const [listed] = await library.listFolders(auth);
    expect(listed).toMatchObject({ name: "Taxes", documentCount: 1 });
    expect((await vault.getVaultDocuments(auth, folder.id)).map((row) => row.title)).toEqual(["W-2"]);
  });

  it("never shows a stored markdown title as markup", async () => {
    const auth = await seed("title");
    await addDocument(auth, { title: "> ## Documentation Index", origin: "upload" });
    const [row] = await vault.getVaultDocuments(auth, null);
    expect(row.title).toBe("Documentation Index");
  });
});

suite("0312 data step", () => {
  const MIGRATION = "src/db/migrations/0312_zettelize_jobs_and_document_titles.sql";

  it("turns a pending zettel request into a queued job and retitles a markup document", async () => {
    const auth = await seed("m0312");
    const [capture] = await holder.db
      .insert(captures)
      .values({
        workspaceId: auth.workspaceId,
        kind: "text",
        captureMode: "authored",
        rawPayload: {},
        text: "A body",
        title: "> ## Documentation Index",
        createdBy: auth.userId,
      })
      .returning();
    await holder.db.insert(outboxEvents).values({
      workspaceId: auth.workspaceId,
      topic: "capture.zettels_requested",
      payload: { captureId: capture.id },
    });
    const doc = await addDocument(auth, { title: "> ## Documentation Index", origin: "capture" });
    await holder.db.insert(documentExtractions).values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      contentHash: `ch-${crypto.randomUUID()}`,
      status: "succeeded",
      text: "> ## Documentation Index\n>\n> Fetch the full index first.\n\n# Vector index selection\n\nBody.",
    });
    const bare = await addDocument(auth, { title: "## Notes on retrieval", origin: "capture" });

    const statements = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint");
    const rollback = new Error("rollback");
    await handle!.client
      .begin(async (sql) => {
        for (const statement of statements) await sql.unsafe(statement);
        const jobs = await sql`
          select kind, subject, status, title, input, created_by from generation_jobs
          where workspace_id = ${auth.workspaceId}`;
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          kind: "zettels.source",
          subject: `capture:${capture.id}`,
          status: "queued",
          title: "Ideas: Documentation Index",
          created_by: auth.userId,
        });
        const events = await sql`
          select topic from outbox_events where workspace_id = ${auth.workspaceId} and status = 'pending'`;
        expect(events.map((e) => e.topic)).toEqual(["generation.job_requested"]);
        const titles = await sql`select id, title from documents where id in (${doc.id}, ${bare.id})`;
        const byId = new Map(titles.map((t) => [t.id, t.title]));
        expect(byId.get(doc.id)).toBe("Vector index selection");
        expect(byId.get(bare.id)).toBe("Notes on retrieval");
        throw rollback;
      })
      .catch((cause: unknown) => {
        if (cause !== rollback) throw cause;
      });
  });
});
