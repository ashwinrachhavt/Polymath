import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, blobObjects, requestReceipts } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Voice capture invariants on real Postgres, mirroring the file-intake
 * suite: an attached recording becomes a voice capture whose only label is
 * the filename (text stays null - nothing is transcribed or promised as
 * searchable); an idempotent replay returns the first capture; a lost
 * concurrent race cleans up its own object; a sniff mismatch quarantines
 * instead of rejecting and never serves inline; verified audio serves inline
 * with its sniffed type and honors byte ranges (the audio player issues
 * range requests); a foreign workspace gets 404; a storage failure leaves
 * no rows; oversize is a 413; empty is a 400. The object-store adapter is
 * an in-memory map that records puts and deletes; the route logic runs for
 * real.
 *
 * The WAV fixture is a real synthesized recording: 0.1 s of 440 Hz mono
 * 16-bit PCM at 8 kHz in a valid RIFF/WAVE container (tests/fixtures/
 * voice-note.wav), verified structurally AND by a real decoder (ffprobe:
 * pcm_s16le, 800 samples, clean full decode) at authoring time. The route
 * never decodes - sniffing + storage is the contract - but the fixture must
 * be genuinely playable, not magic bytes alone.
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

import { POST } from "@/app/api/v1/captures/voice/route";
import { GET } from "@/app/api/v1/captures/[captureId]/file/route";

beforeAll(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
});

// The real playable recording (see the header comment) - loaded from the
// fixture file so what the route stores is exactly what a decoder verified.
const WAV = new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", "voice-note.wav")));
// Neither a known audio signature nor anything else: the quarantine path.
const UNIDENTIFIABLE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

function uploadRequest(bytes: Uint8Array, filename: string, idempotencyKey?: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename));
  const headers = new Headers();
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request("https://axiom.dev/api/v1/captures/voice", { method: "POST", headers, body: form });
}

function getRequest(captureId: string, range?: string) {
  const headers = new Headers();
  if (range) headers.set("range", range);
  return new Request(`https://axiom.dev/api/v1/captures/${captureId}/file`, { headers });
}

async function seed(slug: string) {
  const db = holder.db!;
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  holder.auth = { userId, workspaceId, role: "owner" };
  return { db, userId, workspaceId };
}

suite("capture voice intake", () => {
  it("an attached recording becomes a voice capture whose only label is the filename", async () => {
    const { db, workspaceId } = await seed("capture-voice-basic");
    const res = await POST(uploadRequest(WAV, "standup memo.wav"), undefined);
    const body = (await res.json()) as { captureId: string; quarantined: boolean; contentHash: string };
    expect(res.status, `status ${res.status}: ${JSON.stringify(body)}`).toBe(201);
    expect(body.quarantined).toBe(false);

    const [capture] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    expect(capture.kind).toBe("voice");
    expect(capture.source).toBe("quick_capture");
    expect(capture.blobId).not.toBeNull();
    // The audio's content is never promised: no working text, filename only.
    expect(capture.text).toBeNull();
    const payload = capture.rawPayload as Record<string, unknown>;
    expect(payload.filename).toBe("standup memo.wav");
    expect(payload.mimeType).toBe("audio/wav");
    expect(payload.sizeBytes).toBe(WAV.byteLength);
    expect(payload.quarantined).toBeUndefined();

    const blobs = await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId));
    expect(blobs).toHaveLength(1);
    expect(blobs[0].id).toBe(capture.blobId);
    expect(blobs[0].mimeType).toBe("audio/wav");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "capture.created")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("a replay with the same idempotency key returns the same capture and writes nothing twice", async () => {
    const { db, workspaceId } = await seed("capture-voice-replay");
    const key = crypto.randomUUID();
    const putsBefore = calls.puts;

    const first = await POST(uploadRequest(WAV, "memo.wav", key), undefined);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { captureId: string };

    const replay = await POST(uploadRequest(WAV, "memo.wav", key), undefined);
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
    const { db, workspaceId } = await seed("capture-voice-race");
    const key = crypto.randomUUID();
    const putsBefore = calls.puts;
    const deletesBefore = calls.deletes.length;

    const [a, b] = await Promise.all([
      POST(uploadRequest(WAV, "race.wav", key), undefined),
      POST(uploadRequest(WAV, "race.wav", key), undefined),
    ]);
    const bodyA = (await a.json()) as { captureId: string };
    const bodyB = (await b.json()) as { captureId: string };
    expect(a.status, `a: ${a.status} ${JSON.stringify(bodyA)}`).toBe(201);
    expect(b.status, `b: ${b.status} ${JSON.stringify(bodyB)}`).toBe(201);
    expect(bodyA.captureId).toBe(bodyB.captureId);

    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(1);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(1);
    expect(await db.select().from(requestReceipts).where(eq(requestReceipts.idempotencyKey, key))).toHaveLength(1);
    // Same race-window invariant as the file suite: 1-2 puts, and every
    // stored object beyond the winner's was removed.
    const racedPuts = calls.puts - putsBefore;
    const racedDeletes = calls.deletes.length - deletesBefore;
    expect(racedPuts).toBeGreaterThanOrEqual(1);
    expect(racedPuts).toBeLessThanOrEqual(2);
    expect(racedDeletes).toBe(racedPuts - 1);
    const reachable = [...store.keys()].filter((k) => k.includes(workspaceId));
    expect(reachable).toHaveLength(1);
  });

  it("unidentifiable bytes quarantine the original instead of rejecting it, and never serve inline", async () => {
    const { db } = await seed("capture-voice-quarantine");
    const res = await POST(uploadRequest(UNIDENTIFIABLE, "mystery.mp3"), undefined);
    const body = (await res.json()) as { captureId: string; quarantined: boolean };
    expect(res.status).toBe(201);
    expect(body.quarantined).toBe(true);

    const [capture] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    expect(capture.kind).toBe("voice");
    const payload = capture.rawPayload as Record<string, unknown>;
    expect(payload.quarantined).toBe(true);
    expect(payload.mimeType).toBe("application/octet-stream");

    const dl = await GET(getRequest(body.captureId), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(dl.headers.get("Content-Disposition")).toContain("attachment");
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // A quarantined attachment always arrives whole, even with a range ask.
    const ranged = await GET(getRequest(body.captureId, "bytes=0-3"), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(ranged.status).toBe(200);
  });

  it("verified audio serves inline with the sniffed type and honors byte ranges; a foreign workspace gets 404", async () => {
    const { db } = await seed("capture-voice-inline");
    const res = await POST(uploadRequest(WAV, "memo.wav"), undefined);
    const body = (await res.json()) as { captureId: string };
    expect(res.status).toBe(201);

    const dl = await GET(getRequest(body.captureId), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("audio/wav");
    expect(dl.headers.get("Content-Disposition")).toContain("inline");
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(dl.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(WAV);

    // A single range gets a 206 slice with the true Content-Range - what the
    // browser's audio element actually asks for.
    const slice = await GET(getRequest(body.captureId, "bytes=0-43"), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(slice.status).toBe(206);
    expect(slice.headers.get("Content-Range")).toBe(`bytes 0-43/${WAV.byteLength}`);
    expect(slice.headers.get("Content-Type")).toBe("audio/wav");
    expect(new Uint8Array(await slice.arrayBuffer())).toEqual(WAV.subarray(0, 44));

    // An unsatisfiable range answers 416 with the real total, never a 200.
    const unsat = await GET(getRequest(body.captureId, `bytes=${WAV.byteLength + 100}-`), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(unsat.status).toBe(416);
    expect(unsat.headers.get("Content-Range")).toBe(`bytes */${WAV.byteLength}`);

    // A second workspace knows nothing about the first workspace's capture.
    const other = await seedWorkspace(db, `capture-voice-foreign-${Date.now()}`);
    holder.auth = { userId: other.userId, workspaceId: other.workspaceId, role: "owner" };
    const foreign = await GET(getRequest(body.captureId), { params: Promise.resolve({ captureId: body.captureId }) });
    expect(foreign.status).toBe(404);
  });

  it("a storage failure leaves no rows behind, and a later retry with the same key succeeds", async () => {
    const { db, workspaceId } = await seed("capture-voice-storage-fail");
    const key = crypto.randomUUID();

    calls.failNextPut = true;
    const failed = await POST(uploadRequest(WAV, "retry.wav", key), undefined);
    expect(failed.status).toBe(503);
    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(requestReceipts).where(eq(requestReceipts.idempotencyKey, key))).toHaveLength(0);

    const retry = await POST(uploadRequest(WAV, "retry.wav", key), undefined);
    expect(retry.status).toBe(201);
    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(1);
  });

  it("audio over the deploy-supported cap gets a clear 413 before any storage", async () => {
    const { db, workspaceId } = await seed("capture-voice-oversize");
    const big = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x41);
    const res = await POST(uploadRequest(big, "huge.wav"), undefined);
    expect(res.status).toBe(413);
    const problem = (await res.json()) as { code?: string };
    expect(problem.code).toBe("payload_too_large");
    expect(await db.select().from(captures).where(eq(captures.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select().from(blobObjects).where(eq(blobObjects.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("converting a voice capture makes a task titled from the filename and keeps the recording on the capture", async () => {
    const { db } = await seed("capture-voice-convert");
    const res = await POST(uploadRequest(WAV, "call followup.wav"), undefined);
    const body = (await res.json()) as { captureId: string };
    expect(res.status).toBe(201);

    const { convertCaptureToTask } = await import("@/domains/capture/commands");
    const [before] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    const { task } = await convertCaptureToTask(holder.auth!, { captureId: body.captureId, expectedVersion: before.version });

    const { tasks } = await import("@/domains/work/schema");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.title).toBe("call followup.wav");

    const [after] = await db.select().from(captures).where(eq(captures.id, body.captureId));
    expect(after.processingState).toBe("converted");
    expect(after.convertedType).toBe("task");
    expect(after.convertedId).toBe(task.id);
    expect(after.blobId).toBe(before.blobId);
    expect(after.blobId).not.toBeNull();
  });

  it("an empty upload is rejected, not quarantined", async () => {
    await seed("capture-voice-empty");
    const res = await POST(uploadRequest(new Uint8Array([]), "empty.wav"), undefined);
    expect(res.status).toBe(400);
  });
});
