import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxParkError } from "@/domains/audit/outbox";
import { outboxEvents } from "@/domains/audit/schema";
import { captureProposals, captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-318: the URL -> fetched text -> classification chain, in both event
 * orders, with a terminal failed fetch. Scrape and judge are counting fakes;
 * nothing leaves the process.
 */

const scrape = vi.hoisted(() => ({ calls: 0, markdown: "" }));
vi.mock("@/integrations/firecrawl/client", () => ({
  scrapeToMarkdown: async () => {
    scrape.calls += 1;
    return { markdown: scrape.markdown, title: "A page", url: "", statusCode: 200, error: null };
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
let commands: typeof import("@/domains/capture/commands");
let urlHandler: typeof import("@/domains/capture/url-content-handler");
let enrichment: typeof import("@/domains/capture/enrichment-handler");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = handle.db;
  commands = await import("@/domains/capture/commands");
  urlHandler = await import("@/domains/capture/url-content-handler");
  enrichment = await import("@/domains/capture/enrichment-handler");
});

afterAll(async () => {
  await handle?.client.end();
});

const PAGE = "The page argues that planning should be restructured around fewer, larger bets. ".repeat(6);

async function seed(tag: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `url-chain-${tag}-${Date.now()}`);
  const auth = ownerAuth(userId, workspaceId);
  const capture = await commands.createCapture(auth, { text: `https://example.com/${tag}-${Date.now()}` });
  return { workspaceId, capture };
}

const eventsOf = async (workspaceId: string, topic: string) =>
  db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, topic)));

/** What the dispatcher does once a handler returns. */
const dispatch = (id: string) => db.update(outboxEvents).set({ status: "dispatched" }).where(eq(outboxEvents.id, id));

const judger = () => ({
  calls: 0,
  states: [] as string[],
  async judge(input: { state: string }) {
    this.calls += 1;
    this.states.push(input.state);
    return { answers: {}, model: "fake-jev" };
  },
});

suite("url capture chain", () => {
  it("fetch first: the page text lands, then enrichment classifies the page (not the address)", async () => {
    scrape.calls = 0;
    scrape.markdown = PAGE;
    const { workspaceId, capture } = await seed("forward");
    const [urlEvent] = await eventsOf(workspaceId, "capture.url_content_requested");
    const [enrichEvent] = await eventsOf(workspaceId, "capture.enrichment_requested");
    await urlHandler.urlContentRequestedHandler(urlEvent as never);
    await dispatch(urlEvent.id);
    const j = judger();
    await enrichment.runCaptureEnrichment(enrichEvent as never, { judger: j as never });
    expect(scrape.calls).toBe(1);
    expect(j.calls).toBe(1);
    expect(j.states[0]).toContain("fewer, larger bets");
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("enriched");
    expect(row.text).toContain("fewer, larger bets");
    expect(await db.select().from(captureProposals).where(eq(captureProposals.captureId, capture.id))).toHaveLength(1);
  });

  it("enrichment first: it waits for the outstanding fetch, drops nothing, and runs once the page is in", async () => {
    scrape.calls = 0;
    scrape.markdown = PAGE;
    const { workspaceId, capture } = await seed("reverse");
    const [urlEvent] = await eventsOf(workspaceId, "capture.url_content_requested");
    const [enrichEvent] = await eventsOf(workspaceId, "capture.enrichment_requested");
    const j = judger();
    await expect(enrichment.runCaptureEnrichment(enrichEvent as never, { judger: j as never })).rejects.toBeInstanceOf(
      OutboxParkError,
    );
    expect(j.calls).toBe(0);
    let [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("unprocessed");

    await urlHandler.urlContentRequestedHandler(urlEvent as never);
    await dispatch(urlEvent.id);
    await enrichment.runCaptureEnrichment(enrichEvent as never, { judger: j as never });
    expect(scrape.calls).toBe(1);
    expect(j.calls).toBe(1);
    expect(j.states[0]).toContain("fewer, larger bets");
    [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("enriched");
  });

  it("a duplicate fetch event after success is a no-op (one scrape)", async () => {
    scrape.calls = 0;
    scrape.markdown = PAGE;
    const { workspaceId } = await seed("dup");
    const [urlEvent] = await eventsOf(workspaceId, "capture.url_content_requested");
    await urlHandler.urlContentRequestedHandler(urlEvent as never);
    await urlHandler.urlContentRequestedHandler(urlEvent as never);
    expect(scrape.calls).toBe(1);
  });

  it("a terminal failed fetch records the reason and enrichment proceeds on the address, no endless wait", async () => {
    scrape.calls = 0;
    scrape.markdown = "";
    const { workspaceId, capture } = await seed("failed");
    const [urlEvent] = await eventsOf(workspaceId, "capture.url_content_requested");
    const [enrichEvent] = await eventsOf(workspaceId, "capture.enrichment_requested");
    await urlHandler.urlContentRequestedHandler(urlEvent as never);
    await dispatch(urlEvent.id);
    const j = judger();
    await enrichment.runCaptureEnrichment(enrichEvent as never, { judger: j as never });
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("enriched");
    // Canonical url-only captures carry text:null until a fetch lands (the URL is
    // provenance, not the capture), so a terminal failure leaves an address-only capture.
    expect(row.text).toBeNull();
    expect(row.failureReason).toBeTruthy();
  });

  it("a claimed fetch (still 'pending' with an outbox lease) and a retrying one (available_at in the future) both hold enrichment", async () => {
    const claimed = await seed("claimed");
    const [claimedUrl] = await eventsOf(claimed.workspaceId, "capture.url_content_requested");
    const [claimedEnrich] = await eventsOf(claimed.workspaceId, "capture.enrichment_requested");
    await db
      .update(outboxEvents)
      .set({ leaseOwner: "w1", leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 20_000) })
      .where(eq(outboxEvents.id, claimedUrl.id));
    const j = judger();
    await expect(enrichment.runCaptureEnrichment(claimedEnrich as never, { judger: j as never })).rejects.toMatchObject(
      { name: "OutboxParkError", retryAfterMs: expect.any(Number) },
    );

    const retrying = await seed("retrying");
    const [retryUrl] = await eventsOf(retrying.workspaceId, "capture.url_content_requested");
    const [retryEnrich] = await eventsOf(retrying.workspaceId, "capture.enrichment_requested");
    await db
      .update(outboxEvents)
      .set({ attempts: 2, availableAt: new Date(Date.now() + 120_000) })
      .where(eq(outboxEvents.id, retryUrl.id));
    const err = await enrichment
      .runCaptureEnrichment(retryEnrich as never, { judger: j as never })
      .catch((e: unknown) => e as OutboxParkError);
    // The wait follows the fetch's own backoff (about 2 minutes), not a fixed poll.
    expect(err).toBeInstanceOf(OutboxParkError);
    expect((err as OutboxParkError).retryAfterMs).toBeGreaterThan(60_000);
    expect(j.calls).toBe(0);
  });

  it("an old fetch event that is still pending keeps holding enrichment (age is not terminal)", async () => {
    const old = await seed("old");
    const [oldUrl] = await eventsOf(old.workspaceId, "capture.url_content_requested");
    const [oldEnrich] = await eventsOf(old.workspaceId, "capture.enrichment_requested");
    await db
      .update(outboxEvents)
      .set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) })
      .where(eq(outboxEvents.id, oldUrl.id));
    await expect(
      enrichment.runCaptureEnrichment(oldEnrich as never, { judger: judger() as never }),
    ).rejects.toBeInstanceOf(OutboxParkError);
  });

  it("a dead fetch event is terminal: enrichment proceeds on the address", async () => {
    const dead = await seed("dead");
    const [deadUrl] = await eventsOf(dead.workspaceId, "capture.url_content_requested");
    const [deadEnrich] = await eventsOf(dead.workspaceId, "capture.enrichment_requested");
    await db.update(outboxEvents).set({ status: "dead" }).where(eq(outboxEvents.id, deadUrl.id));
    await enrichment.runCaptureEnrichment(deadEnrich as never, { judger: judger() as never });
    const [row] = await db.select().from(captures).where(eq(captures.id, dead.capture.id));
    expect(row.processingState).toBe("enriched");
  });

  it("classifying with no text (crash or unpark) still fetches once; classifying with text does not refetch", async () => {
    scrape.calls = 0;
    scrape.markdown = PAGE;
    const empty = await seed("cls-empty");
    const [emptyUrl] = await eventsOf(empty.workspaceId, "capture.url_content_requested");
    await db
      .update(captures)
      .set({ processingState: "classifying", text: null })
      .where(eq(captures.id, empty.capture.id));
    await urlHandler.urlContentRequestedHandler(emptyUrl as never);
    await urlHandler.urlContentRequestedHandler(emptyUrl as never);
    expect(scrape.calls).toBe(1);
    const [emptyRow] = await db.select().from(captures).where(eq(captures.id, empty.capture.id));
    expect(emptyRow).toMatchObject({
      processingState: "classifying",
      text: expect.stringContaining("fewer, larger bets"),
    });

    scrape.calls = 0;
    const full = await seed("cls-full");
    const [fullUrl] = await eventsOf(full.workspaceId, "capture.url_content_requested");
    await db
      .update(captures)
      .set({ processingState: "classifying", text: "already fetched page text" })
      .where(eq(captures.id, full.capture.id));
    await urlHandler.urlContentRequestedHandler(fullUrl as never);
    expect(scrape.calls).toBe(0);
  });

  it("there is no retry after a terminal failure: re-pasting the URL is refused and enqueues nothing", async () => {
    scrape.markdown = "";
    const { workspaceId, capture } = await seed("repaste");
    const [urlEvent] = await eventsOf(workspaceId, "capture.url_content_requested");
    await urlHandler.urlContentRequestedHandler(urlEvent as never);
    await dispatch(urlEvent.id);
    const [{ url }] = await db.select({ url: captures.url }).from(captures).where(eq(captures.id, capture.id));
    const { userId } = await db
      .select({ userId: captures.createdBy })
      .from(captures)
      .where(eq(captures.id, capture.id))
      .then((r) => ({ userId: r[0].userId as string }));
    await expect(commands.createCapture(ownerAuth(userId, workspaceId), { text: url as string })).rejects.toMatchObject(
      {
        existingId: capture.id,
      },
    );
    expect(await eventsOf(workspaceId, "capture.url_content_requested")).toHaveLength(1);
  });
});
