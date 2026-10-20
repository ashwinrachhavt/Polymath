import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, documentExtractions, files } from "@/domains/knowledge/schema";
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
  provider.extract.mockResolvedValue({ ok: true, text: "Extracted text", spans: [], pageCount: 1, extractor: "fixture@1" });
});

async function seed(status?: "failed" | "succeeded" | "pending" | "skipped") {
  const db = holder.db!;
  const auth = { ...await seedWorkspace(db, `extract-${crypto.randomUUID()}`), role: "owner" as const };
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({
    workspaceId: auth.workspaceId, blobId: blob.id, filename: "fixture.pdf",
  }).returning();
  const [doc] = await db.insert(documents).values({
    workspaceId: auth.workspaceId, title: "Fixture", fileId: file.id, mimeType: "application/pdf",
  }).returning();
  const [extraction] = status ? await db.insert(documentExtractions).values({
    workspaceId: auth.workspaceId, documentId: doc.id, contentHash: blob.contentHash,
    status, text: status === "succeeded" ? "Durable evidence" : null,
    error: status === "failed" ? "first attempt failed" : null,
  }).returning() : [];
  return { auth, doc, blob, extraction };
}

suite("document extraction retry and claim invariants (real Postgres)", () => {
  it("retries a failed row and reuses its evidence identity instead of returning false success", async () => {
    const { auth, doc, extraction, blob } = await seed("failed");
    const result = await extractDocument(auth, { documentId: doc.id });
    expect(result).toEqual({ ok: true, extractionId: extraction.id, text: "Extracted text", deduplicated: false, proposals: "succeeded" });
    expect(readBlob).toHaveBeenCalledWith(blob.storageKey);
    expect(provider.extract).toHaveBeenCalledOnce();
    const rows = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: extraction.id, status: "succeeded", error: null });
  });

  it("a failed retry stays failed, never ok:true with empty text", async () => {
    const { auth, doc, extraction } = await seed("failed");
    provider.extract.mockResolvedValueOnce({ ok: false, error: "provider unavailable", extractor: "fixture@1" });
    expect(await extractDocument(auth, { documentId: doc.id })).toEqual({
      ok: false, extractionId: extraction.id, error: "provider unavailable",
    });
    const [row] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extraction.id));
    expect(row).toMatchObject({ status: "failed", text: null });
  });

  it("an empty docling payload is a named failure, never a silent empty success", async () => {
    const { auth, doc, extraction } = await seed("failed");
    provider.extract.mockResolvedValueOnce({ ok: true, text: "", spans: [], pageCount: null, extractor: "docling-serve@fixture" });
    const result = await extractDocument(auth, { documentId: doc.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no readable text|empty/i);
    const [row] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extraction.id));
    expect(row).toMatchObject({ status: "failed" });
  });

  it("successful evidence is immutable and deduplicates without reading or paying again", async () => {
    const { auth, doc, extraction } = await seed("succeeded");
    expect(await extractDocument(auth, { documentId: doc.id })).toEqual({
      ok: true, extractionId: extraction.id, text: "Durable evidence", deduplicated: true, proposals: "succeeded",
    });
    expect(readBlob).not.toHaveBeenCalled();
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it.each(["pending", "skipped"] as const)("does not report %s as successful extraction", async (status) => {
    const { auth, doc } = await seed(status);
    expect(await extractDocument(auth, { documentId: doc.id })).toMatchObject({ ok: false });
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it.each([undefined, "failed"] as const)("concurrent callers claim only one provider attempt (prior status %s)", async (status) => {
    const { auth, doc } = await seed(status);
    let release: ((result: ExtractionResult) => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    provider.extract.mockImplementationOnce(() => {
      entered?.();
      return new Promise<ExtractionResult>((resolve) => { release = resolve; });
    });
    const first = extractDocument(auth, { documentId: doc.id });
    await waiting;
    try {
      expect(await extractDocument(auth, { documentId: doc.id })).toMatchObject({ ok: false, error: expect.stringContaining("in progress") });
      expect(provider.extract).toHaveBeenCalledOnce();
    } finally {
      release?.({ ok: true, text: "Winner", spans: [], pageCount: 1, extractor: "fixture@1" });
    }
    expect(await first).toMatchObject({ ok: true, text: "Winner", deduplicated: false });
    expect(await extractDocument(auth, { documentId: doc.id })).toMatchObject({ ok: true, text: "Winner", deduplicated: true });
    const rows = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id));
    expect(rows).toHaveLength(1);
  });

  it("storage exceptions release the claim so a later attempt can really retry", async () => {
    const { auth, doc } = await seed();
    vi.mocked(readBlob).mockRejectedValueOnce(new Error("private read rejected"));
    await expect(extractDocument(auth, { documentId: doc.id })).rejects.toThrow("private read rejected");
    const [row] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id));
    expect(row.status).toBe("failed");
    expect(await extractDocument(auth, { documentId: doc.id })).toMatchObject({ ok: true, extractionId: row.id });
  });

  it("rejects another workspace before accessing its private blob", async () => {
    const { auth, doc } = await seed();
    await expect(extractDocument({ ...auth, workspaceId: crypto.randomUUID() }, { documentId: doc.id })).rejects.toThrow("not found in workspace");
    expect(readBlob).not.toHaveBeenCalled();
  });
});
