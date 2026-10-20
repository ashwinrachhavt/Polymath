import { createServer, type Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { documents, files, sources } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-178: a crawl is a queued job, not a 20-second request.
 *
 * What these prove, and why each one matters:
 *
 * - the tool enqueues and returns "queued" instead of a partial page set, so a
 *   crawl that outlives a request never reports success on a quarter of a site
 * - a still-running crawl is parked with a future available_at and its attempt
 *   count untouched; a release that forgot the reschedule would spin the worker
 * - a terminal crawl lands every page as a document AND a source row, which is
 *   what makes crawled material readable and citable
 * - re-delivery converges: same page, same content hash, no second document
 * - a provider that cannot be reached parks the row instead of spending an
 *   attempt, so a stopped Firecrawl does not dead-letter real work
 *
 * Firecrawl is a local HTTP fixture; Postgres is real.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let client: NonNullable<typeof handle>["client"];
let outbox: typeof import("@/domains/audit/outbox");
let handlers: typeof import("@/domains/audit/outbox-handlers");
let webFetch: typeof import("@/domains/knowledge/web-fetch");
let server: Server;
let base: string;
let crawlStatus: string;
let pollCount: number;

const PAGES = [
  { metadata: { sourceURL: "https://docs.example/one", title: "One" }, markdown: "First page body." },
  { metadata: { sourceURL: "https://docs.example/two", title: "Two" }, markdown: "Second page body." },
];

beforeAll(async () => {
  if (!handle) return;
  ({ db, client } = handle);
  outbox = await import("@/domains/audit/outbox");
  handlers = await import("@/domains/audit/outbox-handlers");
  webFetch = await import("@/domains/knowledge/web-fetch");

  server = createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/v1/crawl") {
      req.resume();
      req.on("end", () => json({ success: true, id: "job-1", status: "scraping" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/crawl/job-1") {
      pollCount += 1;
      return json({ success: true, status: crawlStatus, data: crawlStatus === "completed" ? PAGES : [] });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  await handle?.client.end();
});

beforeEach(async () => {
  if (!handle) return;
  crawlStatus = "scraping";
  pollCount = 0;
  vi.stubEnv("FIRECRAWL_API_URL", base);
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
  await db.execute(sql`delete from outbox_events`);
});

async function workspace(slug: string) {
  const seeded = await seedWorkspace(db, `crawl-${slug}-${Date.now()}`);
  return ownerAuth(seeded.userId, seeded.workspaceId);
}

async function queuedRow(workspaceId: string) {
  const [row] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.workspaceId, workspaceId));
  return row;
}

const crawlHandlers = () => handlers.outboxHandlers(client);

suite("crawl queue (real Postgres)", () => {
  it("the agent tool enqueues a crawl and returns queued, not a partial page set", async () => {
    const auth = await workspace("enqueue");
    const result = await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/", limit: 30, maxDepth: 2 });

    expect(result).toMatchObject({ ok: true, queued: true, url: "https://docs.example/", limit: 30, maxDepth: 2 });
    const row = await queuedRow(auth.workspaceId);
    expect(row.topic).toBe("crawl.requested");
    expect(row.status).toBe("pending");
    expect(row.dispatchKey).toBe("crawl:https://docs.example/");
  });

  it("a second ask for the same site joins the running crawl instead of starting another", async () => {
    const auth = await workspace("dedupe");
    const first = await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/" });
    const second = await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/#top" });
    expect(first.ok && second.ok).toBe(true);
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("submits on the first pass, then parks a running crawl without spending an attempt", async () => {
    const auth = await workspace("park");
    await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/" });
    const row = await queuedRow(auth.workspaceId);

    const first = await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w1" });
    const errRow = await queuedRow(auth.workspaceId);
    console.log("LAST ERROR:", errRow.lastError);
    expect(first).toMatchObject({ claimed: 1, dispatched: 0, failed: 0, parked: 1 });

    const afterSubmit = await queuedRow(auth.workspaceId);
    expect((afterSubmit.payload as { jobId: string }).jobId).toBe("job-1");
    expect(afterSubmit.status).toBe("pending");
    expect(afterSubmit.attempts).toBe(0);
    expect(afterSubmit.leaseOwner).toBeNull();
    // Parked, not immediately re-claimable: a release without a reschedule spins.
    expect(afterSubmit.availableAt.getTime()).toBeGreaterThan(Date.now());

    await client`update outbox_events set available_at = now() - interval '1 second' where id = ${row.id}`;
    const second = await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w2" });
    expect(second).toMatchObject({ claimed: 1, dispatched: 0, failed: 0, parked: 1 });

    const afterPoll = await queuedRow(auth.workspaceId);
    expect(pollCount).toBe(1);
    expect(afterPoll.status).toBe("pending");
    expect(afterPoll.attempts).toBe(0);
  });

  it("a terminal crawl lands one document and one source row per page", async () => {
    const auth = await workspace("land");
    await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/" });
    const row = await queuedRow(auth.workspaceId);

    await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w1" }); // submit
    await client`update outbox_events set available_at = now() - interval '1 second' where id = ${row.id}`;
    crawlStatus = "completed";
    const done = await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w2" });
    expect(done).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });

    const docs = await db.select().from(documents).where(eq(documents.workspaceId, auth.workspaceId));
    expect(docs.map((d) => d.sourceUrl).sort()).toEqual(["https://docs.example/one", "https://docs.example/two"]);
    expect(docs.every((d) => d.fileId !== null)).toBe(true);
    const fileRows = await db.select().from(files).where(eq(files.workspaceId, auth.workspaceId));
    expect(fileRows.every((f) => f.origin === "crawl")).toBe(true);

    const src = await db.select().from(sources).where(eq(sources.workspaceId, auth.workspaceId));
    expect(src.map((s) => s.url).sort()).toEqual(["https://docs.example/one", "https://docs.example/two"]);
    expect(src.every((s) => s.kind === "web")).toBe(true);
    expect(src.every((s) => s.providerRequestId === "job-1")).toBe(true);
    expect(src.every((s) => s.contentHash !== null)).toBe(true);
  });

  it("re-delivery of a completed crawl converges on the same rows", async () => {
    const auth = await workspace("redeliver");
    await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/" });
    const row = await queuedRow(auth.workspaceId);
    await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w1" });

    crawlStatus = "completed";
    await client`update outbox_events set available_at = now() - interval '1 second' where id = ${row.id}`;
    await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w2" });

    // The same event delivered again (lost completion response) must not double-write.
    await client`update outbox_events set status = 'pending', available_at = now() - interval '1 second' where id = ${row.id}`;
    await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w3" });

    const docs = await db.select().from(documents).where(eq(documents.workspaceId, auth.workspaceId));
    const src = await db.select().from(sources).where(eq(sources.workspaceId, auth.workspaceId));
    expect(docs).toHaveLength(2);
    expect(src).toHaveLength(2);
  });

  it("a provider that cannot be reached parks the row instead of spending an attempt", async () => {
    const auth = await workspace("down");
    await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/" });

    vi.stubEnv("FIRECRAWL_API_URL", "http://127.0.0.1:9"); // nothing listens here
    const pass = await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w1" });
    expect(pass).toMatchObject({ claimed: 1, dispatched: 0, failed: 0, deferred: 1 });

    const after = await queuedRow(auth.workspaceId);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);
    expect(after.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("an abandoned crawl fails rather than polling forever", async () => {
    const auth = await workspace("abandon");
    await webFetch.crawlSiteForAgent(auth, { url: "https://docs.example/" });
    const { id } = await queuedRow(auth.workspaceId);
    // Pretend the job id has been outstanding for longer than the ceiling.
    await db
      .update(outboxEvents)
      .set({ payload: { url: "https://docs.example/", jobId: "job-1", startedAt: new Date(Date.now() - 31 * 60_000).toISOString() } })
      .where(eq(outboxEvents.id, id));

    const pass = await outbox.dispatchPendingOutbox(client, crawlHandlers(), { workerId: "w1" });
    expect(pass.failed).toBe(1);
    const after = await queuedRow(auth.workspaceId);
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain("did not finish within");
  });
});
