import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects, outboxEvents, requestReceipts } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * File intake invariants that need real Postgres: an Idempotency-Key replay
 * returns the first document instead of creating a second one, and a content
 * mismatch quarantines the original rather than rejecting it (a preserved
 * original beats a lost upload). The route logic runs for real; only the
 * transports are swapped — @/lib/db points at the scratch database and Vercel
 * Blob's put is stubbed, the same swap policy.test.ts makes.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. Fresh unique slugs, no truncation, following the other suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: { db: ReturnType<typeof drizzle> | undefined; auth: { userId: string; workspaceId: string; role: "owner" } | undefined } = {
  db: undefined,
  auth: undefined,
};

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true }));
// The route's authedHandler would call Clerk's auth() otherwise; the suite
// supplies the AuthContext directly, same swap the other suites make.
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ isAuthenticated: true, userId: "clerk_test" })),
}));
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => holder.auth),
}));
// The route imports the putBlob adapter, not @vercel/blob directly, so mock
// the adapter. The key must be unique per call — blob_objects.storage_key has
// a unique index and the suite runs more than one upload.
vi.mock("@/integrations/object-store/vercel-blob", () => ({
  putBlob: vi.fn(async (input: { filename: string }) => ({
    storageKey: `https://blob.test/${input.filename}/${crypto.randomUUID()}`,
    contentHash: "test-hash",
    sizeBytes: 8,
  })),
}));

import { POST } from "@/app/api/v1/files/route";

beforeAll(() => {
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
});

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const TEXT = new TextEncoder().encode("plain text pretending to be nothing in particular");

function uploadRequest(bytes: Uint8Array, title: string, idempotencyKey?: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "doc.pdf"));
  form.set("title", title);
  // Node generates the multipart boundary itself; setting a fake one made
  // formData() unable to parse the body.
  const headers = new Headers();
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request("https://axiom.dev/api/v1/files", { method: "POST", headers, body: form });
}

suite("file intake", () => {
  it("a replay with the same idempotency key returns the same document and creates no duplicate", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `file-intake-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const key = crypto.randomUUID();

    const first = await POST(uploadRequest(PDF, "First upload", key), undefined);
    const firstBody = (await first.json()) as { documentId: string; status?: number };
    expect(first.status, `first: ${first.status} ${JSON.stringify(firstBody)}`).toBe(201);

    const replay = await POST(uploadRequest(PDF, "First upload", key), undefined);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { documentId: string }).documentId).toBe(firstBody.documentId);

    const docs = await db.select().from(documents).where(eq(documents.workspaceId, workspaceId));
    expect(docs).toHaveLength(1);
    const receipts = await db
      .select()
      .from(requestReceipts)
      .where(eq(requestReceipts.idempotencyKey, key));
    expect(receipts).toHaveLength(1);
  });

  it("a sniff mismatch quarantines the original instead of rejecting it", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `file-quarantine-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };

    const res = await POST(uploadRequest(TEXT, "Not a pdf"), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileId: string; fileStatus: string };
    expect(body.fileStatus).toBe("quarantined");

    const [fileRow] = await db.select().from(files).where(eq(files.id, body.fileId));
    expect(fileRow.status).toBe("quarantined");

    // No document, no extraction request: a quarantined file is not content.
    const docs = await db.select().from(documents).where(eq(documents.workspaceId, workspaceId));
    expect(docs).toHaveLength(0);
    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, workspaceId));
    expect(outbox).toHaveLength(0);
  });

  it("a clean upload writes the blob, the document, and the extraction outbox row together", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `file-clean-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };

    const res = await POST(uploadRequest(PDF, "Clean upload"), undefined);
    expect(res.status).toBe(201);
    const { documentId } = (await res.json()) as { documentId: string };

    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.mimeType).toBe("application/pdf");
    const blobs = await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId));
    expect(blobs).toHaveLength(1);
    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, workspaceId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].topic).toBe("document.extraction_requested");
    expect(outbox[0].payload).toEqual({ documentId });
  });
});
