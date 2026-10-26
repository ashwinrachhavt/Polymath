import { and, eq } from "drizzle-orm";
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

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let urlHandler: typeof import("@/domains/capture/url-content-handler");
let enrichment: typeof import("@/domains/capture/enrichment-handler");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
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
    expect(row.text).toContain("example.com");
  });

  it("a dead or stuck fetch event is not waited on forever", async () => {
    const dead = await seed("dead");
    const [deadUrl] = await eventsOf(dead.workspaceId, "capture.url_content_requested");
    const [deadEnrich] = await eventsOf(dead.workspaceId, "capture.enrichment_requested");
    await db.update(outboxEvents).set({ status: "dead" }).where(eq(outboxEvents.id, deadUrl.id));
    await enrichment.runCaptureEnrichment(deadEnrich as never, { judger: judger() as never });
    const [deadRow] = await db.select().from(captures).where(eq(captures.id, dead.capture.id));
    expect(deadRow.processingState).toBe("enriched");

    const stuck = await seed("stuck");
    const [stuckUrl] = await eventsOf(stuck.workspaceId, "capture.url_content_requested");
    const [stuckEnrich] = await eventsOf(stuck.workspaceId, "capture.enrichment_requested");
    await db
      .update(outboxEvents)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(outboxEvents.id, stuckUrl.id));
    await enrichment.runCaptureEnrichment(stuckEnrich as never, { judger: judger() as never });
    const [stuckRow] = await db.select().from(captures).where(eq(captures.id, stuck.capture.id));
    expect(stuckRow.processingState).toBe("enriched");
  });
});
