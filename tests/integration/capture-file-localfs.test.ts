import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects, outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The capture image rung against the REAL local object store (no adapter
 * mocks): upload through the route with no BLOB token - the store falls back
 * to local disk in non-production, which exists precisely so upload and
 * extraction run without Vercel Blob - serve the bytes back through the file
 * route, then let the rung read them through the same real seam. This is the
 * automated end-to-end proof for the rung's storage contract: capture first,
 * enrich async, bytes never re-encoded between store and reader.
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
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ isAuthenticated: true, userId: "clerk_test" })),
}));
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => holder.auth),
}));

import { POST } from "@/app/api/v1/captures/file/route";
import { GET } from "@/app/api/v1/captures/[captureId]/file/route";

const blobDir = mkdtempSync(join(tmpdir(), "axiom-capture-ocr-"));
let db: NonNullable<typeof handle>["db"];

beforeAll(() => {
  // No BLOB token + non-production = local-fs mode; aim the store at this run's dir.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("AXIOM_LOCAL_BLOB_DIR", blobDir);
  if (!handle) return;
  holder.db = handle.db;
  db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
  rmSync(blobDir, { recursive: true, force: true });
});

// A signature fixture: valid PNG magic for the sniff path, NOT a decodable image.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

// Short on purpose: under the LLM threshold, so the deterministic tiers own the outcome.
const READING = "Whiteboard photo: keep the review on Thursday.";
const read = vi.fn(async () => ({
  ok: true as const,
  text: READING,
  spans: [{ page: 1, start: 0, end: READING.length }],
  pageCount: 1,
  extractor: "fixture:openrouter-vision",
}));

function uploadRequest(bytes: Uint8Array, filename: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename));
  return new Request("https://axiom.dev/api/v1/captures/file", { method: "POST", body: form });
}

suite("capture image ocr rung over local-fs storage", () => {
  it("upload stores on local disk, serve returns the original bytes, and the rung reads them", async () => {
    const { userId, workspaceId } = await seedWorkspace(
      db!,
      `capture-ocr-localfs-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    );
    holder.auth = { userId, workspaceId, role: "owner" };

    const res = await POST(uploadRequest(PNG, "whiteboard.png"), undefined);
    const body = (await res.json()) as { captureId: string; quarantined: boolean };
    expect(res.status, `status ${res.status}: ${JSON.stringify(body)}`).toBe(201);
    expect(body.quarantined).toBe(false);

    // The bytes sit on local disk under a local: key, not a Vercel Blob URL.
    const [capture] = await db!.select().from(captures).where(eq(captures.id, body.captureId));
    const [blob] = await db!.select().from(blobObjects).where(eq(blobObjects.id, capture.blobId!));
    expect(blob.storageKey.startsWith("local:")).toBe(true);

    // Serving renders the original bytes inline under the sniffed type.
    const served = await GET(new Request(`https://axiom.dev/api/v1/captures/${body.captureId}/file`), {
      params: Promise.resolve({ captureId: body.captureId }),
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // The rung reads through the same real object-store seam and lands the
    // reading as the capture's text.
    const handler = await import("@/domains/capture/enrichment-handler");
    const events = await db!.select().from(outboxEvents);
    const event = events.find((e) => (e.payload as { captureId: string }).captureId === body.captureId);
    expect(event).toBeDefined();
    await handler.runCaptureEnrichment(
      { id: event!.id, workspaceId, topic: event!.topic, payload: event!.payload } as Parameters<
        typeof handler.runCaptureEnrichment
      >[0],
      { ocr: { extract: read } },
    );
    expect(read).toHaveBeenCalledOnce();

    const [row] = await db!.select().from(captures).where(eq(captures.id, body.captureId));
    expect(row.text).toBe(READING);
    expect(row.processingState).toBe("enriched");
  });
});
