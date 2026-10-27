import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, blobObjects, requestReceipts } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * File capture invariants on real Postgres: a file upload becomes a capture
 * whose only label is the filename (text stays null - the file's content is
 * never promised as searchable); an idempotent replay returns the first
 * capture and cannot stack a second stored object; a lost concurrent race
 * cleans up its own object; a sniff mismatch quarantines instead of
 * rejecting; quarantined bytes are never served inline; a foreign workspace
 * gets 404. The object-store adapter is an in-memory map that records puts
 * and deletes; the route logic runs for real.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. Fresh unique slugs, no truncation, following the other suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: {
  db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = { db: undefined, auth: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ isAuthenticated: true, userId: "clerk_test" })),
}));
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => holder.auth),
}));

// In-memory object store behind the adapter mock: records every put and
// delete so the suite can assert no orphaned or duplicated stored objects.
const store = new Map<string, Uint8Array>();
const calls = { puts: 0, deletes: [] as string[], failNextPut: false };
vi.mock("@/integrations/object-store/vercel-blob", () => ({
  putBlob: vi.fn(async (input: { bytes: Uint8Array; filename: string; workspaceId: string; contentHash?: string }) => {
    if (calls.failNextPut) {
      calls.failNextPut = false;
      throw new Error("blob store unavailable");
    }
    calls.puts += 1;
    const storageKey = `https://blob.test/${input.workspaceId}/${crypto.randomUUID()}/${input.filename}`;
    store.set(storageKey, input.bytes);
    return { storageKey, contentHash: input.contentHash ?? "test-hash", sizeBytes: input.bytes.byteLength };
  }),
  readBlob: vi.fn(async (storageKey: string) => {
    const bytes = store.get(storageKey);
    if (!bytes) throw new Error("Stored blob is unavailable");
    return bytes;
  }),
  deleteBlob: vi.fn(async (storageKey: string) => {
    calls.deletes.push(storageKey);
    store.delete(storageKey);
  }),
}));

import { POST } from "@/app/api/v1/captures/file/route";
import { GET } from "@/app/api/v1/captures/[captureId]/file/route";

beforeAll(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
});

// A signature fixture: valid PNG magic for the sniff path, NOT a decodable
// image. The route never decodes - it stores bytes and serves them with the
// sniffed type + nosniff, so signature validity is the property under test.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
// Neither a known signature nor printable text: the quarantine path.
const UNIDENTIFIABLE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

function uploadRequest(bytes: Uint8Array, filename: string, idempotencyKey?: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename));
  const headers = new Headers();
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request("https://axiom.dev/api/v1/captures/file", { method: "POST", headers, body: form });
}

function getRequest(captureId: string) {
  return new Request(`https://axiom.dev/api/v1/captures/${captureId}/file`);
}

async function seed(slug: string) {
  const db = holder.db!;
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  holder.auth = { userId, workspaceId, role: "owner" };
  return { db, userId, workspaceId };
}

suite("capture file intake", () => {
  it("a file upload becomes a file capture whose only label is the filename", async () => {
    const { db, workspaceId } = await seed("capture-file-basic");
    const res = await POST(uploadRequest(PNG, "screen shot.png"), undefined);
    const body = (await res.json()) as { captureId: string; quarantined: boolean; contentHash: string };
    expect(res.status, `status ${res.status}: ${JSON.stringify(body)}`).toBe(201);
    expect(body.quarantined).toBe(false);

    const [capture] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    expect(capture.kind).toBe("file");
    expect(capture.source).toBe("quick_capture");
    expect(capture.blobId).not.toBeNull();
    // The file's content is never promised: no working text, filename only.
    expect(capture.text).toBeNull();
    const payload = capture.rawPayload as Record<string, unknown>;
    expect(payload.filename).toBe("screen shot.png");
    expect(payload.mimeType).toBe("image/png");
    expect(payload.sizeBytes).toBe(PNG.byteLength);
    expect(payload.quarantined).toBeUndefined();

    const blobs = await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId));
    expect(blobs).toHaveLength(1);
    expect(blobs[0].id).toBe(capture.blobId);
    expect(blobs[0].mimeType).toBe("image/png");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "capture.created")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("a replay with the same idempotency key returns the same capture and writes nothing twice", async () => {
    const { db, workspaceId } = await seed("capture-file-replay");
    const key = crypto.randomUUID();
    const putsBefore = calls.puts;

    const first = await POST(uploadRequest(PNG, "shot.png", key), undefined);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { captureId: string };

    const replay = await POST(uploadRequest(PNG, "shot.png", key), undefined);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { captureId: string }).captureId).toBe(firstBody.captureId);

    const rows = await db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(1);
    expect(await db.select().from(requestReceipts).where(eq(requestReceipts.idempotencyKey, key))).toHaveLength(1);
    // The route pre-check short-circuited before the second blob write.
    expect(calls.puts).toBe(putsBefore + 1);
  });

  it("two concurrent first attempts with one key create one capture, and the loser removes its own object", async () => {
    const { db, workspaceId } = await seed("capture-file-race");
    const key = crypto.randomUUID();
    const putsBefore = calls.puts;
    const deletesBefore = calls.deletes.length;

    const [a, b] = await Promise.all([
      POST(uploadRequest(PNG, "race.png", key), undefined),
      POST(uploadRequest(PNG, "race.png", key), undefined),
    ]);
    const bodyA = (await a.json()) as { captureId: string };
    const bodyB = (await b.json()) as { captureId: string };
    expect(a.status, `a: ${a.status} ${JSON.stringify(bodyA)}`).toBe(201);
    expect(b.status, `b: ${b.status} ${JSON.stringify(bodyB)}`).toBe(201);
    expect(bodyA.captureId).toBe(bodyB.captureId);

    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(1);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(1);
    expect(await db.select().from(requestReceipts).where(eq(requestReceipts.idempotencyKey, key))).toHaveLength(1);
    // The race window is timing-dependent: if the loser's pre-check lands
    // after the winner's receipt commits, it replays before storing anything
    // (1 put, 0 deletes); if both race past it, the loser cleans up its own
    // object (2 puts, 1 delete). The invariant either way: every stored
    // object beyond the winner's was removed, and exactly one object remains
    // reachable for this workspace.
    const racedPuts = calls.puts - putsBefore;
    const racedDeletes = calls.deletes.length - deletesBefore;
    expect(racedPuts).toBeGreaterThanOrEqual(1);
    expect(racedPuts).toBeLessThanOrEqual(2);
    expect(racedDeletes).toBe(racedPuts - 1);
    const reachable = [...store.keys()].filter((k) => k.includes(workspaceId));
    expect(reachable).toHaveLength(1);
  });

  it("unidentifiable bytes quarantine the original instead of rejecting it, and never serve inline", async () => {
    const { db } = await seed("capture-file-quarantine");
    const res = await POST(uploadRequest(UNIDENTIFIABLE, "mystery.bin"), undefined);
    const body = (await res.json()) as { captureId: string; quarantined: boolean };
    expect(res.status).toBe(201);
    expect(body.quarantined).toBe(true);

    const [capture] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    const payload = capture.rawPayload as Record<string, unknown>;
    expect(payload.quarantined).toBe(true);
    expect(payload.mimeType).toBe("application/octet-stream");

    const dl = await GET(getRequest(body.captureId), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(dl.headers.get("Content-Disposition")).toContain("attachment");
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("a verified image serves inline with the sniffed type, and a foreign workspace gets 404", async () => {
    const { db } = await seed("capture-file-inline");
    const res = await POST(uploadRequest(PNG, "whiteboard.png"), undefined);
    const body = (await res.json()) as { captureId: string };
    expect(res.status).toBe(201);

    const dl = await GET(getRequest(body.captureId), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("image/png");
    expect(dl.headers.get("Content-Disposition")).toContain("inline");
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG);

    // A second workspace knows nothing about the first workspace's capture.
    const other = await seedWorkspace(db, `capture-file-foreign-${Date.now()}`);
    holder.auth = { userId: other.userId, workspaceId: other.workspaceId, role: "owner" };
    const foreign = await GET(getRequest(body.captureId), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(foreign.status).toBe(404);
  });

  it("a storage failure leaves no rows behind, and a later retry with the same key succeeds", async () => {
    const { db, workspaceId } = await seed("capture-file-storage-fail");
    const key = crypto.randomUUID();

    calls.failNextPut = true;
    const failed = await POST(uploadRequest(PNG, "retry.png", key), undefined);
    expect(failed.status).toBe(503);
    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(requestReceipts).where(eq(requestReceipts.idempotencyKey, key))).toHaveLength(0);

    const retry = await POST(uploadRequest(PNG, "retry.png", key), undefined);
    expect(retry.status).toBe(201);
    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(1);
  });

  it("a file over the deploy-supported cap gets a clear 413 before any storage", async () => {
    const { db, workspaceId } = await seed("capture-file-oversize");
    const big = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x41);
    const res = await POST(uploadRequest(big, "huge.png"), undefined);
    expect(res.status).toBe(413);
    const problem = (await res.json()) as { code?: string };
    expect(problem.code).toBe("payload_too_large");
    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("converting a file capture makes a task titled from the filename and keeps the file on the capture", async () => {
    const { db } = await seed("capture-file-convert");
    const res = await POST(uploadRequest(PNG, "design notes.png"), undefined);
    const body = (await res.json()) as { captureId: string };
    expect(res.status).toBe(201);

    const { convertCaptureToTask } = await import("@/domains/capture/commands");
    const [before] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    const { task } = await convertCaptureToTask(holder.auth!, { captureId: body.captureId, expectedVersion: before.version });

    const { tasks } = await import("@/domains/work/schema");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.title).toBe("design notes.png");

    const [after] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    expect(after.processingState).toBe("converted");
    expect(after.convertedType).toBe("task");
    expect(after.convertedId).toBe(task.id);
    // The attachment lineage survives: the converted capture still points at
    // the stored file, and the detail pane still offers it.
    expect(after.blobId).toBe(before.blobId);
    expect(after.blobId).not.toBeNull();
  });

  it("an empty file is rejected, not quarantined", async () => {
    await seed("capture-file-empty");
    const res = await POST(uploadRequest(new Uint8Array([]), "empty.png"), undefined);
    expect(res.status).toBe(400);
  });
});
