import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { workspaces } from "@/domains/identity/schema";
import { captureProposals, captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * The enrichment ladder runs as an outbox consumer behind the URL handler.
 * Verified here: enqueue on every capture (URL tier delayed 30s so the scrape
 * lands first), Tier 0+1 landing on the row without any model, the LLM tier
 * writing title/domain/tags as signal, unconfigured-provider skipping instead
 * of failing, a readable-but-wrong model answer degrading to enriched with the
 * deterministic tiers intact rather than retrying forever, an enabled-but-
 * unfunded Jev tier degrading to the same ladder and saying so, and Tier 0
 * reading the mode's working text (the fetched page for a page capture, the
 * selection for a selection).
 */

const generate = vi.fn();

vi.mock("@/integrations/generation/provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/generation/provider")>();
  return {
    ...original,
    generationProvider: vi.fn(() => ({
      name: "test:model",
      registryId: "test",
      generate: (...args: unknown[]) => generate(...(args as [])),
    })),
  };
});

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let handler: typeof import("@/domains/capture/enrichment-handler");
let auth: AuthContext;
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
  handler = await import("@/domains/capture/enrichment-handler");
  const seeded = await seedWorkspace(db, `capture-enrichment-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

const { generationProvider } = await import("@/integrations/generation/provider");

beforeEach(() => {
  generate.mockReset();
  vi.mocked(generationProvider).mockReset();
  vi.mocked(generationProvider).mockImplementation(() => ({
    name: "test:model",
    registryId: "test",
    generate: (...args: unknown[]) => generate(...(args as [])),
  }) as never);
});

afterEach(() => vi.unstubAllEnvs());

/** The fetch's own event, so a URL capture can be enriched without waiting for a scrape. */
async function settleUrlFetch(captureId: string) {
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
  const urlEvent = events.find((e) => (e.payload as { captureId: string }).captureId === captureId);
  if (!urlEvent) throw new Error("no url fetch event enqueued");
  await db.update(outboxEvents).set({ status: "dispatched" }).where(eq(outboxEvents.id, urlEvent.id));
}

const LONG_PROSE = Array.from(
  { length: 12 },
  (_, i) => `Sentence ${i} of prose long enough that the model tier is worth asking.`,
).join(" ");

async function enqueueAndRun(captureId: string) {
  const events = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
  const event = events.find((e) => (e.payload as { captureId: string }).captureId === captureId);
  if (!event) throw new Error("no enrichment event enqueued");
  await handler.captureEnrichmentRequestedHandler({
    id: event.id,
    workspaceId,
    topic: event.topic,
    payload: event.payload,
  } as Parameters<typeof handler.captureEnrichmentRequestedHandler>[0]);
}

async function getCapture(id: string) {
  const [row] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  return row;
}

suite("capture enrichment ladder", () => {
  it("enqueues enrichment for a text capture immediately and a URL capture delayed", async () => {
    const text = await commands.createCapture(auth, { text: "A short thought." });
    const page = await commands.createCapture(auth, { text: "https://example.com/article" });

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
    const byCapture = new Map(events.map((e) => [(e.payload as { captureId: string }).captureId, e]));
    const textEvent = byCapture.get(text.id);
    const urlEvent = byCapture.get(page.id);
    expect(textEvent).toBeDefined();
    expect(urlEvent).toBeDefined();
    // The URL capture's enrichment waits for the scrape (due in the future);
    // the text capture's is due now.
    expect(textEvent!.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(urlEvent!.availableAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });

  it("runs Tier 0+1 only on short text: no model call, row lands enriched", async () => {
    const capture = await commands.createCapture(auth, { text: "A short thought." });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.cleanText).toBe("A short thought.");
    expect(row.structure).toBe("prose");
    expect(generate).not.toHaveBeenCalled();
  });

  it("skips the model for structure captures: URL, code, list", async () => {
    const code = await commands.createCapture(auth, {
      text: "```ts\nconst a = 1;\nconst b = 2;\nconst c = a + b;\n```",
    });
    await enqueueAndRun(code.id);
    const row = await getCapture(code.id);
    expect(row.structure).toBe("code");
    expect(row.processingState).toBe("enriched");
    expect(generate).not.toHaveBeenCalled();
  });

  it("escalates long prose to the LLM and stores title, domain, tags", async () => {
    generate.mockResolvedValue({
      text: JSON.stringify({ title: "Quarterly planning notes", domain: "product", tags: ["planning", "q4"] }),
    });
    const prose = Array.from({ length: 12 }, (_, i) => `This is sentence ${i} of a longer captured essay on planning the quarter ahead with care.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.title).toBe("Quarterly planning notes");
    expect(row.domain).toBe("product");
    expect(row.tags).toEqual(["planning", "q4"]);
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0][0] as { prompt: string };
    expect(prompt.prompt).toContain("<<<BEGIN_DOCUMENT>>>");
  });

  it("skips to enriched when no generation provider is configured", async () => {
    const { GenerationUnconfiguredError } = await import("@/integrations/generation/provider");
    vi.mocked(generationProvider).mockImplementation(() => {
      throw new GenerationUnconfiguredError();
    });
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence ${i}: prose long enough to want the model tier today.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.structure).toBe("prose");
    expect(row.cleanText).toBeTruthy();
  });

  it("degrades an unreadable model answer to enriched with tiers 0+1 intact", async () => {
    generate.mockResolvedValue({ text: "not json at all" });
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence ${i} of deliberate prose for the unreadable-answer case here.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.failureReason).toContain("unreadable");
    expect(row.cleanText).toBeTruthy();
  });

  it("clears a stale failure once real text enriches on the deterministic path", async () => {
    const capture = await commands.createCapture(auth, { text: "A short thought that needs no model." });
    await db.update(captures).set({ failureReason: "An earlier attempt failed." }).where(eq(captures.id, capture.id));
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.failureReason).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("clears a stale failure once long prose enriches through the model", async () => {
    generate.mockResolvedValue({
      text: JSON.stringify({ title: "Recovered essay", domain: "product", tags: ["recovery"] }),
    });
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence ${i} of a recovered essay with enough prose for the model tier.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await db.update(captures).set({ failureReason: "An earlier attempt failed." }).where(eq(captures.id, capture.id));
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.title).toBe("Recovered essay");
    expect(row.failureReason).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("clears a stale failure on the unconfigured-provider path when real text exists", async () => {
    const { GenerationUnconfiguredError } = await import("@/integrations/generation/provider");
    vi.mocked(generationProvider).mockImplementation(() => {
      throw new GenerationUnconfiguredError();
    });
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence ${i}: prose long enough to want the model tier today.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await db.update(captures).set({ failureReason: "An earlier attempt failed." }).where(eq(captures.id, capture.id));
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.failureReason).toBeNull();
  });

  it("leaves a converted capture untouched", async () => {
    const capture = await commands.createCapture(auth, { text: "A short thought." });
    await db
      .update(captures)
      .set({ processingState: "converted" })
      .where(eq(captures.id, capture.id));
    await enqueueAndRun(capture.id);
    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("converted");
    expect(row.cleanText).toBeNull();
  });

  it("falls back to the deterministic ladder when Jev has no allowance, and says so", async () => {
    // The registry enables Jev; an unset or zero allowance makes jevClassifier
    // refuse before any HTTP. A key is present so that refusal is the quota,
    // not the unconfigured path. No generation provider either, so the row is
    // the deterministic tiers alone plus the reason the paid one was skipped.
    const { GenerationUnconfiguredError } = await import("@/integrations/generation/provider");
    vi.mocked(generationProvider).mockImplementation(() => {
      throw new GenerationUnconfiguredError();
    });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("JEV_MONTHLY_INPUT_TOKENS", "0");
    const capture = await commands.createCapture(auth, { text: LONG_PROSE });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.enrichmentLeaseToken).toBeNull();
    expect(row.cleanText).toBe(LONG_PROSE);
    expect(row.failureReason).toContain("paid classification tier");
    expect(await db.select().from(captureProposals).where(eq(captureProposals.captureId, capture.id))).toHaveLength(0);
  });

  it("still runs the generation tier after a skipped paid tier", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("JEV_MONTHLY_INPUT_TOKENS", "0");
    generate.mockResolvedValue({ text: JSON.stringify({ title: "Allowance-free title", domain: null, tags: null }) });
    const capture = await commands.createCapture(auth, { text: LONG_PROSE });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.title).toBe("Allowance-free title");
    expect(row.failureReason).toContain("paid classification tier");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("normalizes the fetched page for a page capture, leaving the grab as the person's text", async () => {
    generate.mockResolvedValue({ text: JSON.stringify({ title: "Page reading", domain: null, tags: null }) });
    const capture = await commands.createCapture(auth, {
      text: "grabbed innerText",
      url: `https://example.com/page-${Date.now()}`,
      mode: "page",
    });
    await db.update(captures).set({ fetchedText: LONG_PROSE }).where(eq(captures.id, capture.id));
    await settleUrlFetch(capture.id);
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.text).toBe("grabbed innerText");
    expect(row.cleanText).toBe(LONG_PROSE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("normalizes the selection, not the page it was read from", async () => {
    // A selection never fetches its page (the words are what the person chose),
    // so fetchedText is null in practice. Setting it here proves tier 0 reads
    // the working text for the mode rather than whatever is longest on the row.
    const capture = await commands.createCapture(auth, {
      text: "The selected sentence.",
      url: `https://example.com/selection-${Date.now()}`,
      mode: "selection",
    });
    await db.update(captures).set({ fetchedText: LONG_PROSE }).where(eq(captures.id, capture.id));
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.cleanText).toBe("The selected sentence.");
    expect(generate).not.toHaveBeenCalled();
  });
});
