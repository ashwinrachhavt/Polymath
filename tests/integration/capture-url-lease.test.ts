import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxParkError } from "@/domains/audit/outbox";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-305: the URL fetch shares the capture's fenced lease, so an unpark
 * re-queue racing a claimed fetch waits instead of scraping twice. The scrape
 * is a counting fake; nothing leaves the process.
 */

const scrape = vi.hoisted(() => ({
  calls: 0,
  gate: null as null | Promise<void>,
  entered: null as null | (() => void),
}));
vi.mock("@/integrations/firecrawl/client", () => ({
  scrapeToMarkdown: async () => {
    scrape.calls += 1;
    scrape.entered?.();
    await scrape.gate;
    return { markdown: "Fetched page body", title: "A page" };
  },
}));

// The handlers under test read the module-level db and withTransaction; point
// both at the test database (same holder pattern as semantic-relations.test.ts).
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
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

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let urlHandler: typeof import("@/domains/capture/url-content-handler");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = handle.db;
  urlHandler = await import("@/domains/capture/url-content-handler");
});

afterAll(async () => {
  await handle?.client.end();
});

const URL_ = "https://example.com/article";

async function seed(tag: string) {
  const { workspaceId } = await seedWorkspace(db, `url-lease-${tag}-${Date.now()}`);
  const [capture] = await db
    .insert(captures)
    .values({ workspaceId, kind: "url", url: URL_, captureMode: "url-reference", rawPayload: { url: URL_ } })
    .returning();
  return { workspaceId, capture };
}

const event = (workspaceId: string, captureId: string) =>
  ({
    id: crypto.randomUUID(),
    workspaceId,
    topic: "capture.url_content_requested",
    payload: { captureId, url: URL_ },
  }) as never;

suite("url content lease", () => {
  it("forced overlap: the duplicate fetch event is parked, the page is scraped once, the redelivery is a no-op", async () => {
    scrape.calls = 0;
    const { workspaceId, capture } = await seed("overlap");
    let release!: () => void;
    scrape.gate = new Promise<void>((resolve) => (release = resolve));
    const inScrape = new Promise<void>((resolve) => (scrape.entered = resolve));
    const runA = urlHandler.urlContentRequestedHandler(event(workspaceId, capture.id));
    await inScrape;
    await expect(urlHandler.urlContentRequestedHandler(event(workspaceId, capture.id))).rejects.toBeInstanceOf(
      OutboxParkError,
    );
    release();
    await runA;
    await urlHandler.urlContentRequestedHandler(event(workspaceId, capture.id));
    expect(scrape.calls).toBe(1);
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    // ASH-318 handoff: a successful fetch lands the page and hands the capture
    // to enrichment (classifying); it no longer finishes the capture itself.
    expect(row).toMatchObject({
      processingState: "classifying",
      text: expect.stringContaining("Fetched page body"),
      enrichmentLeaseToken: null,
    });
  });

  it("an expired fetch holder is fenced: its late result cannot overwrite the newer holder's text", async () => {
    scrape.calls = 0;
    const { workspaceId, capture } = await seed("stale");
    let release!: () => void;
    scrape.gate = new Promise<void>((resolve) => (release = resolve));
    const inScrape = new Promise<void>((resolve) => (scrape.entered = resolve));
    const stale = urlHandler.urlContentRequestedHandler(event(workspaceId, capture.id));
    await inScrape;
    await db
      .update(captures)
      .set({ enrichmentLeaseUntil: new Date(Date.now() - 1000) })
      .where(eq(captures.id, capture.id));
    scrape.entered = null;
    scrape.gate = Promise.resolve();
    await urlHandler.urlContentRequestedHandler(event(workspaceId, capture.id));
    await db.update(captures).set({ text: "owner edit after fetch" }).where(eq(captures.id, capture.id));
    release();
    await stale;
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.text).toBe("owner edit after fetch");
    expect(scrape.calls).toBe(2);
  });

  it("a failed fetch records the reason, frees the lease, and leaves the capture in the queue", async () => {
    const { workspaceId } = await seedWorkspace(db, `url-lease-bad-${Date.now()}`);
    const [capture] = await db
      .insert(captures)
      .values({ workspaceId, kind: "url", url: "http://localhost/x", captureMode: "url-reference", rawPayload: {} })
      .returning();
    await urlHandler.urlContentRequestedHandler({
      id: crypto.randomUUID(),
      workspaceId,
      topic: "capture.url_content_requested",
      payload: { captureId: capture.id, url: "http://localhost/x" },
    } as never);
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.failureReason).toBeTruthy();
    expect(row).toMatchObject({ processingState: "unprocessed", enrichmentLeaseToken: null });
  });
});
