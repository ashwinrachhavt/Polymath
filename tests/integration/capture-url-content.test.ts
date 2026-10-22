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

async function lastOutboxEvent(topic: string) {
  const [row] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.topic, topic))
    .orderBy(outboxEvents.id)
    .limit(1);
  return row;
}

async function runHandlerFor(captureId: string) {
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
  const event = events.find((e) => (e.payload as { captureId?: string }).captureId === captureId);
  if (!event) throw new Error(`no url content event for capture ${captureId}`);
  await handlerModule.urlContentRequestedHandler(event as never);
}

suite("capture url content", () => {
  it("enqueues url_content_requested in the same transaction as the capture", async () => {
    const capture = await commands.createCapture(auth, { text: "https://example.com/spec" });
    const event = await lastOutboxEvent("capture.url_content_requested");
    expect(event).toBeTruthy();
    expect((event!.payload as { captureId?: string }).captureId).toBe(capture.id);
    expect(event!.workspaceId).toBe(workspaceId);
  });

  it("a text capture enqueues nothing", async () => {
    await commands.createCapture(auth, { text: "Just a thought" });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
    // Only the URL capture from the previous test produced an event.
    expect(events).toHaveLength(1);
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
    expect(row.processingState).toBe("enriched");
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
    expect(row.processingState).toBe("enriched");
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
