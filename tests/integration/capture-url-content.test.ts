import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { workspaces } from "@/domains/identity/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * A URL capture is a promise to read the page. The capture row lands with the
 * URL, an outbox row is written in the same transaction, and the handler fills
 * the capture's text from Firecrawl (sites) or the transcript API (YouTube).
 * A fetch that fails leaves the reason on the capture; it does not retry blind.
 */

const scrape = vi.fn();
const fetchTranscript = vi.fn();

vi.mock("@/integrations/firecrawl/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/firecrawl/client")>();
  return { ...original, scrapeToMarkdown: (...args: unknown[]) => scrape(...(args as [])) };
});
vi.mock("@/integrations/youtube/transcript", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/youtube/transcript")>();
  return { ...original, fetchTranscript: (...args: unknown[]) => fetchTranscript(...(args as [])) };
});

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let handlerModule: typeof import("@/domains/capture/url-content-handler");
let auth: AuthContext;
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
  handlerModule = await import("@/domains/capture/url-content-handler");
  const seeded = await seedWorkspace(db, `capture-url-content-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

beforeEach(() => {
  scrape.mockReset();
  fetchTranscript.mockReset();
});

async function runHandlerFor(captureId: string) {
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
  const event = events.find((e) => (e.payload as { captureId?: string }).captureId === captureId);
  if (!event) throw new Error(`no url content event for capture ${captureId}`);
  await handlerModule.urlContentRequestedHandler(event as never);
}

/** Run the handler for a capture that has no pending event (a selection is never enqueued one). */
async function runHandlerDirect(captureId: string, url: string) {
  await handlerModule.urlContentRequestedHandler({
    id: crypto.randomUUID(),
    workspaceId,
    topic: "capture.url_content_requested",
    payload: { captureId, url },
    attempts: 0,
    leaseToken: crypto.randomUUID(),
  } as never);
}

suite("capture url content", () => {
  it("enqueues url_content_requested in the same transaction as the capture", async () => {
    const capture = await commands.createCapture(auth, { text: `https://example.com/enqueue-${Date.now()}` });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
    const mine = events.find((e) => (e.payload as { captureId?: string }).captureId === capture.id);
    expect(mine).toBeTruthy();
    expect(mine!.workspaceId).toBe(workspaceId);
  });

  it("a text capture enqueues nothing", async () => {
    const before = (await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"))).length;
    await commands.createCapture(auth, { text: `Just a thought ${Date.now()}` });
    const after = (await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"))).length;
    expect(after).toBe(before);
  });

  it("a companion page grab (text + url) keeps the grab and fills fetched_text", async () => {
    // The companion sends document.body.innerText, a flattened wall: the note
    // it would become has no headings and no paragraphs. The fetch fills
    // `fetchedText` with the page's markdown WITHOUT replacing the grab, which
    // stays the working text (and survives in rawPayload).
    scrape.mockResolvedValue({
      url: "https://example.com/grab-1",
      markdown: "# Real structure\n\nParagraph one.\n\nParagraph two.",
      title: "Real structure",
      statusCode: 200,
      error: null,
    });

    const capture = await commands.createCapture(auth, {
      text: "At Modal, we like to think that we know a thing or two. We build for the GPUs.",
      url: `https://example.com/grab-${Date.now()}`,
      source: "companion",
    });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
    expect(events.some((e) => (e.payload as { captureId?: string }).captureId === capture.id)).toBe(true);

    await runHandlerFor(capture.id);
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.fetchedText).toContain("# Real structure");
    expect(row.fetchOutcome).toBe("acquired");
    expect(row.text).toBe("At Modal, we like to think that we know a thing or two. We build for the GPUs.");
    expect((row.rawPayload as { text?: string }).text).toContain("At Modal, we like to think");
  });

  it("does not fetch the page for a selection, and a fetch that lands keeps the selection", async () => {
    const capture = await commands.createCapture(auth, {
      text: "the paragraph I highlighted",
      url: `https://example.com/kept-${Date.now()}`,
      mode: "selection",
    });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
    expect(events.filter((e) => (e.payload as { captureId?: string }).captureId === capture.id)).toHaveLength(0);

    // Run it directly, the way an operator retry would.
    scrape.mockResolvedValue({ markdown: "# Whole page\n\nall the other words", statusCode: 200, error: null });
    await runHandlerDirect(capture.id, `https://example.com/kept-${Date.now()}`);
    const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(after.text).toBe("the paragraph I highlighted");
    expect(after.fetchedText).toContain("all the other words");
    expect(after.fetchOutcome).toBe("acquired");
  });

  it("records a 404 as error-page and leaves the working text alone", async () => {
    const capture = await commands.createCapture(auth, { text: `https://example.com/missing-${Date.now()}` });
    scrape.mockResolvedValue({ markdown: "Not found", error: "404", statusCode: 404 });
    await runHandlerFor(capture.id);
    const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(after.fetchOutcome).toBe("error-page");
    expect(after.fetchedText).toBeNull();
    expect(after.failureReason).toContain("could not be read");
  });

  it("the handler scrapes a web page into the capture's text", async () => {
    scrape.mockResolvedValue({
      url: "https://example.com/spec-1",
      markdown: "# The spec\n\nEverything about the thing.",
      title: "The spec",
      statusCode: 200,
      error: null,
    });

    const capture = await commands.createCapture(auth, { text: `https://example.com/spec-${Date.now()}` });
    await runHandlerFor(capture.id);

    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.failureReason).toBeNull();
    expect(row.text).toContain("The spec");
    // Fetched, handed to enrichment: classification still has to read the page.
    expect(row.processingState).toBe("classifying");
  });

  it("the handler stores a YouTube transcript as the capture's text", async () => {
    fetchTranscript.mockResolvedValue({
      ok: true as const,
      title: "A talk",
      cues: [{ start: 0, text: "Welcome to the talk." }],
      text: "Welcome to the talk.",
    });

    const capture = await commands.createCapture(auth, {
      text: `https://www.youtube.com/watch?v=abc${Date.now()}`.slice(0, 43) + "x",
    });
    await runHandlerFor(capture.id);

    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.failureReason).toBeNull();
    expect(row.text).toContain("Welcome to the talk.");
    expect(row.processingState).toBe("classifying");
  });

  it("a failed scrape records the reason and leaves the capture readable", async () => {
    scrape.mockResolvedValue({
      url: "https://example.com/dead",
      markdown: "",
      title: null,
      statusCode: 500,
      error: "scrape failed",
    });

    const capture = await commands.createCapture(auth, { text: `https://example.com/dead-${Date.now()}` });
    await runHandlerFor(capture.id);

    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("unprocessed");
    expect(row.failureReason).toContain("could not be read");
  });
});
