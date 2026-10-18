import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documentExtractions, documents, files } from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const provider = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => provider }));
vi.mock("@/integrations/object-store/object-store", () => ({
  putBlob: vi.fn(async (input: { bytes: Uint8Array; contentHash: string; workspaceId: string }) => {
    const storageKey = `private/${input.workspaceId}/${input.contentHash}`;
    blobs.set(storageKey, input.bytes);
    return { storageKey, contentHash: input.contentHash, sizeBytes: input.bytes.byteLength };
  }),
  readBlob: vi.fn(async (key: string) => blobs.get(key)!),
  ObjectStoreUnconfiguredError: class extends Error {},
}));

import { captureUrl } from "@/domains/knowledge/capture-url";

let server: Server;
let base: string;
let hits: Record<string, number> = {};
const PDF = Buffer.from("%PDF-1.4\nrent: 1200");
const fetchOptions = { allowPrivateAddresses: true, timeoutMs: 2000 };

beforeAll(async () => {
  holder.db = handle?.db;
  server = createServer((req, res) => {
    hits[req.url ?? ""] = (hits[req.url ?? ""] ?? 0) + 1;
    if (req.url === "/lease.pdf") return void res.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
    if (req.url === "/page.html") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>hi</html>");
    if (req.url === "/flaky.pdf") {
      return void (hits["/flaky.pdf"] === 1 ? res.writeHead(503).end() : res.writeHead(200).end(PDF));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); server.close(); vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => {
  hits = {};
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
  provider.extract.mockReset();
  provider.extract.mockResolvedValue({ ok: true, text: "rent: 1200", spans: [], pageCount: 1, extractor: "fixture@1" });
});

async function workspace() {
  return { ...await seedWorkspace(holder.db!, `url-${crypto.randomUUID()}`), role: "owner" as const };
}
const docsFor = (workspaceId: string) =>
  holder.db!.select().from(documents).where(eq(documents.workspaceId, workspaceId));

suite("URL capture (real Postgres)", () => {
  it("creates one document with its source URL, a file, and a succeeded extraction", async () => {
    const auth = await workspace();
    const result = await captureUrl(auth, { url: `${base}/lease.pdf#top`, fetchOptions });
    expect(result).toMatchObject({ ok: true, created: true, extraction: { ok: true, text: "rent: 1200" } });
    const [doc] = await docsFor(auth.workspaceId);
    expect(doc).toMatchObject({ sourceUrl: `${base}/lease.pdf`, mimeType: "application/pdf", title: "lease" });
    expect(doc.fileId).not.toBeNull();
    const [file] = await holder.db!.select().from(files).where(eq(files.id, doc.fileId!));
    expect(file).toMatchObject({ origin: "url", status: "uploaded" });
    const [extraction] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id));
    expect(extraction.status).toBe("succeeded");
  });

  it("pasting the same URL again returns the same document without a second row or fetch", async () => {
    const auth = await workspace();
    const first = await captureUrl(auth, { url: `${base}/lease.pdf`, fetchOptions });
    const second = await captureUrl(auth, { url: `${base}/lease.pdf`, fetchOptions });
    expect(first.ok && second.ok && second.documentId === first.documentId).toBe(true);
    expect(second).toMatchObject({ ok: true, created: false, extraction: { deduplicated: true } });
    expect(await docsFor(auth.workspaceId)).toHaveLength(1);
    expect(hits["/lease.pdf"]).toBe(1);
    expect(provider.extract).toHaveBeenCalledOnce();
  });

  it("the same URL in another workspace is its own document", async () => {
    const a = await workspace();
    const b = await workspace();
    const first = await captureUrl(a, { url: `${base}/lease.pdf`, fetchOptions });
    const second = await captureUrl(b, { url: `${base}/lease.pdf`, fetchOptions });
    expect(first.ok && second.ok && first.documentId !== second.documentId).toBe(true);
  });

  it("two simultaneous pastes make one document and one file", async () => {
    const auth = await workspace();
    const [x, y] = await Promise.all([
      captureUrl(auth, { url: `${base}/lease.pdf`, fetchOptions }),
      captureUrl(auth, { url: `${base}/lease.pdf`, fetchOptions }),
    ]);
    expect(x.ok && y.ok && x.documentId === y.documentId).toBe(true);
    expect(await docsFor(auth.workspaceId)).toHaveLength(1);
    const fileRows = await holder.db!.select().from(files).where(eq(files.workspaceId, auth.workspaceId));
    expect(fileRows).toHaveLength(1);
  });

  it("a failed fetch leaves an unfiled, typeless document with the error on an extraction row", async () => {
    const auth = await workspace();
    const result = await captureUrl(auth, { url: `${base}/missing.pdf`, fetchOptions });
    expect(result).toMatchObject({ ok: false, error: "The site answered with status 404." });
    const [doc] = await docsFor(auth.workspaceId);
    expect(doc).toMatchObject({ fileId: null, mimeType: null, sourceUrl: `${base}/missing.pdf` });
    const rows = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "The site answered with status 404.", text: null });
    expect(provider.extract).not.toHaveBeenCalled();
    const blobsRows = await holder.db!.select().from(blobObjects).where(eq(blobObjects.workspaceId, auth.workspaceId));
    expect(blobsRows).toHaveLength(0);
  });

  it("pasting a failed URL again retries on the same document and recovers", async () => {
    const auth = await workspace();
    const first = await captureUrl(auth, { url: `${base}/flaky.pdf`, fetchOptions });
    expect(first).toMatchObject({ ok: false });
    const retry = await captureUrl(auth, { url: `${base}/flaky.pdf`, fetchOptions });
    expect(retry).toMatchObject({ ok: true, created: false, extraction: { ok: true } });
    const all = await docsFor(auth.workspaceId);
    expect(all).toHaveLength(1);
    expect(all[0].fileId).not.toBeNull();
    const [latest] = await holder.db!.select().from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, all[0].id), eq(documentExtractions.status, "succeeded")));
    expect(latest.text).toBe("rent: 1200");
  });

  it("a page that is not a PDF or image fails with a reason and never becomes Filed", async () => {
    const auth = await workspace();
    const result = await captureUrl(auth, { url: `${base}/page.html`, fetchOptions });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not a PDF or image") });
    const [doc] = await docsFor(auth.workspaceId);
    expect(doc.fileId).toBeNull();
  });

  it("refuses a private address before creating anything", async () => {
    const auth = await workspace();
    expect(await captureUrl(auth, { url: "http://169.254.169.254/latest/meta-data" })).toMatchObject({ ok: false, documentId: null });
    expect(await docsFor(auth.workspaceId)).toHaveLength(0);
  });
});
