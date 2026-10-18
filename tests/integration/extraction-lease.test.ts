import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documentStatus } from "@/domains/knowledge/status";
import {
  documentExtractionAttempts,
  documentExtractions,
  documents,
  files,
} from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const provider = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/integrations/object-store/vercel-blob", () => ({ readBlob: vi.fn() }));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => provider }));

import { extractDocument } from "@/domains/knowledge/extraction";
import { readBlob } from "@/integrations/object-store/vercel-blob";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
  vi.mocked(readBlob).mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  provider.extract.mockResolvedValue({ ok: true, text: "Recovered text", spans: [], pageCount: 1, extractor: "fixture@1" });
});

type Status = "failed" | "succeeded" | "pending";

async function seed(status: Status, claimedSecondsAgo: number | null = null) {
  const db = holder.db!;
  const auth = { ...await seedWorkspace(db, `lease-${crypto.randomUUID()}`), role: "owner" as const };
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" }).returning();
  const [doc] = await db.insert(documents).values({
    workspaceId: auth.workspaceId, title: "Lease", fileId: file.id, mimeType: "application/pdf",
  }).returning();
  const [extraction] = await db.insert(documentExtractions).values({
    workspaceId: auth.workspaceId, documentId: doc.id, contentHash: blob.contentHash, status,
    text: status === "succeeded" ? "Durable evidence" : null,
    error: status === "failed" ? "first attempt failed" : null,
    claimedBy: "dead-process",
    claimedAt: claimedSecondsAgo === null ? null : sql`now() - make_interval(secs => ${claimedSecondsAgo})`,
    createdAt: claimedSecondsAgo === null ? undefined : sql`now() - make_interval(secs => ${claimedSecondsAgo})`,
  }).returning();
  return { auth, doc, extraction };
}

const attemptsOf = (id: string) =>
  holder.db!.select().from(documentExtractionAttempts)
    .where(eq(documentExtractionAttempts.extractionId, id))
    .orderBy(documentExtractionAttempts.attempt);

suite("extraction lease (real Postgres)", () => {
  it("two callers race a pending row with an expired lease and only one proceeds", async () => {
    const { auth, doc } = await seed("pending", 3600);
    let release: ((r: ExtractionResult) => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((r) => { entered = r; });
    provider.extract.mockImplementation(() => {
      entered?.();
      return new Promise<ExtractionResult>((r) => { release = r; });
    });
    const calls = [
      extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 }),
      extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 }),
    ];
    await waiting;
    // Give the loser time to finish its claim attempt before the winner ends.
    await new Promise((r) => setTimeout(r, 150));
    release?.({ ok: true, text: "Winner", spans: [], pageCount: 1, extractor: "fixture@1" });
    const results = await Promise.all(calls);
    expect(provider.extract).toHaveBeenCalledOnce();
    expect(results.filter((r) => r.ok && !r.deduplicated)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it("does not reclaim a pending row until its lease expires", async () => {
    const { auth, doc } = await seed("pending", 10);
    const result = await extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("in progress") });
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it("reclaims a pending row older than the timeout and records the abandoned attempt", async () => {
    const { auth, doc, extraction } = await seed("pending", 120);
    await holder.db!.insert(documentExtractionAttempts).values({
      workspaceId: auth.workspaceId, extractionId: extraction.id, attempt: 1, claimedBy: "dead-process",
    });
    const result = await extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 });
    expect(result).toMatchObject({ ok: true, extractionId: extraction.id, text: "Recovered text" });
    const attempts = await attemptsOf(extraction.id);
    expect(attempts.map((a) => [a.attempt, a.outcome])).toEqual([[1, "abandoned"], [2, "succeeded"]]);
    expect(attempts[0].error).toContain("Lease expired");
  });

  it("treats a pending row from before leases existed (no claimedAt) by its age", async () => {
    const { auth, doc } = await seed("pending");
    // createdAt is now, so it is within any lease.
    expect(await extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 })).toMatchObject({ ok: false });
    await holder.db!.execute(sql`update document_extractions set created_at = now() - interval '2 hours' where document_id = ${doc.id}`);
    expect(await extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 })).toMatchObject({ ok: true });
  });

  it("never overwrites a succeeded row, even with an expired-looking lease", async () => {
    const { auth, doc, extraction } = await seed("succeeded", 99999);
    const result = await extractDocument(auth, { documentId: doc.id, leaseSeconds: 1 });
    expect(result).toMatchObject({ ok: true, deduplicated: true, text: "Durable evidence" });
    expect(provider.extract).not.toHaveBeenCalled();
    const [row] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extraction.id));
    expect(row).toMatchObject({ status: "succeeded", text: "Durable evidence" });
    expect(await attemptsOf(extraction.id)).toHaveLength(0);
  });

  it("a retry writes a new attempt row and keeps the earlier error", async () => {
    const { auth, doc, extraction } = await seed("failed");
    provider.extract.mockResolvedValueOnce({ ok: false, error: "second failure", extractor: "fixture@1" });
    await extractDocument(auth, { documentId: doc.id });
    await extractDocument(auth, { documentId: doc.id });
    const attempts = await attemptsOf(extraction.id);
    expect(attempts.map((a) => [a.attempt, a.outcome, a.error])).toEqual([
      [1, "failed", "second failure"],
      [2, "succeeded", null],
    ]);
  });

  it("a failed retry leaves the earlier failure visible until a retry succeeds", async () => {
    const { auth, doc, extraction } = await seed("failed");
    let release: ((r: ExtractionResult) => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((r) => { entered = r; });
    provider.extract.mockImplementationOnce(() => { entered?.(); return new Promise((r) => { release = r; }); });
    const running = extractDocument(auth, { documentId: doc.id });
    await waiting;
    const [mid] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extraction.id));
    expect(mid).toMatchObject({ status: "pending", error: "first attempt failed" });
    release?.({ ok: true, text: "ok", spans: [], pageCount: 1, extractor: "fixture@1" });
    await running;
  });

  it("a process that lost its lease cannot overwrite the new holder's result", async () => {
    const { auth, doc, extraction } = await seed("pending", 120);
    let release: ((r: ExtractionResult) => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((r) => { entered = r; });
    provider.extract.mockImplementationOnce(() => { entered?.(); return new Promise((r) => { release = r; }); });
    const slow = extractDocument(auth, { documentId: doc.id, leaseSeconds: 60 });
    await waiting;
    // Another process takes the row by expiring the slow caller's lease.
    await holder.db!.execute(sql`update document_extractions set claimed_by = 'newer-holder' where id = ${extraction.id}`);
    release?.({ ok: true, text: "stale", spans: [], pageCount: 1, extractor: "fixture@1" });
    expect(await slow).toMatchObject({ ok: false, error: expect.stringContaining("no longer available") });
    const [row] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extraction.id));
    expect(row).toMatchObject({ status: "pending", text: null });
  });

  it("documentStatus keeps its labels: Reading for pending, Could not read for failed", () => {
    expect(documentStatus({ status: "pending" }, 0).label).toBe("Reading");
    expect(documentStatus({ status: "failed", error: "x" }, 0).label).toBe("Could not read");
    // A killed extract is never Filed: no succeeded row means no Filed label.
    expect(documentStatus({ status: "pending", proposalStatus: "succeeded" }, 0).label).not.toBe("Filed");
  });
});
