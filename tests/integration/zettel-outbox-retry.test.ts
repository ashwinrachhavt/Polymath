import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Outbox resilience for "Generate zettels" (real Postgres, real dispatcher):
 * a failed capture.zettels_requested pass retries with backoff instead of
 * losing the request, the recovered pass creates the cards, and a redelivery
 * (the lost-response case) creates no duplicates.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
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

import {
  ZETTEL_GENERATION_TOPIC,
  requestZettelGeneration,
  runZettelGenerationRequested,
} from "@/domains/capture/zettel-generation";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const BODY =
  "Atomic notes compound. A zettel carries one idea, verbatim evidence, and links to its neighbours. Writing them daily turns reading into thinking.";
const Q1 = "A zettel carries one idea, verbatim evidence";

beforeAll(() => {
  holder.db = handle?.db;
  // Generation keys unset: the pass under test is the only consumer, and the
  // no-provider path must not take the live-call route.
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("DOCLING_SERVE_URL", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

const row = (id: string) =>
  holder
    .db!.select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, id))
    .then((r) => r[0]);

suite("capture.zettels_requested retry and replay resilience", () => {
  it("a failed pass retries with backoff, then succeeds once, and redelivery duplicates nothing", async () => {
    if (!handle) return;
    // Scratch DB is shared across suites and reruns: drop still-pending rows
    // for this topic so the dispatcher claims only the row this test creates.
    await handle.client`delete from outbox_events where topic = ${ZETTEL_GENERATION_TOPIC} and status = 'pending'`;
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `zretry-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const outbox = await import("@/domains/audit/outbox");

    const [capture] = await holder
      .db!.insert(captures)
      .values({
        workspaceId,
        kind: "text",
        captureMode: "authored",
        rawPayload: { text: BODY },
        text: BODY,
        processingState: "unprocessed",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();

    const request = await requestZettelGeneration(auth, {
      captureIds: [capture.id],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(request.queued).toBe(1);
    const [queued] = await holder
      .db!.select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, ZETTEL_GENERATION_TOPIC)));

    // First pass: the handler fails the way a network drop inside extraction
    // or the model call would — the dispatcher must record the attempt and
    // back the row off, never lose it. (The scratch DB may hold other topics'
    // due rows, so assertions key on handler invocations and our row's state,
    // not the dispatcher's global claim count.)
    let failingCalls = 0;
    const failing = await outbox.dispatchPendingOutbox(
      handle.client,
      {
        [ZETTEL_GENERATION_TOPIC]: async () => {
          failingCalls += 1;
          throw new Error("provider connection reset");
        },
      },
      { workerId: "test-failing" },
    );
    expect(failingCalls).toBe(1);
    expect(failing.failed).toBeGreaterThanOrEqual(1);

    const afterFailure = await row(queued.id);
    expect(afterFailure.status).toBe("pending");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.lastError).toContain("provider connection reset");
    expect(afterFailure.availableAt.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(afterFailure.dispatchedAt ?? null).toBeNull();

    // The retry is not due until its backoff passes; a dispatch right now
    // must not invoke the handler for this topic.
    let earlyCalls = 0;
    await outbox.dispatchPendingOutbox(
      handle.client,
      {
        [ZETTEL_GENERATION_TOPIC]: async () => {
          earlyCalls += 1;
          return { created: 0, unreadChars: 0 };
        },
      },
      { workerId: "test-early" },
    );
    expect(earlyCalls).toBe(0);
    expect((await row(queued.id)).attempts).toBe(1);

    // The backoff lapses; the recovered pass files the capture and creates
    // the card exactly once.
    await handle.client`update outbox_events set available_at = now() - interval '1 second' where id = ${queued.id}`;
    const extractor: ZettelExtractor = {
      name: "fake@1",
      extract: async () => [{ title: "One idea", content: "One idea.", quote: Q1 }],
    };
    const deps = {
      auth: async (ws: string) => (ws === workspaceId ? auth : null),
      extractor,
    };
    let recoveredCalls = 0;
    const recovered = await outbox.dispatchPendingOutbox(
      handle.client,
      {
        [ZETTEL_GENERATION_TOPIC]: (event) => {
          recoveredCalls += 1;
          return runZettelGenerationRequested(event, deps);
        },
      },
      { workerId: "test-recovered" },
    );
    expect(recoveredCalls).toBe(1);
    expect(recovered.dispatched).toBeGreaterThanOrEqual(1);

    const settled = await row(queued.id);
    expect(settled.status).toBe("dispatched");
    expect(settled.dispatchedAt ?? null).not.toBeNull();

    const cards = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(1);

    // Redelivery (accepted publish, lost response): the same event runs a
    // second time and creates nothing new.
    const replay = await runZettelGenerationRequested(
      {
        id: queued.id,
        workspaceId,
        topic: ZETTEL_GENERATION_TOPIC,
        payload: { captureId: capture.id },
        attempts: 1,
        leaseToken: crypto.randomUUID(),
      },
      deps,
    );
    expect(replay.created).toBe(0);
    const cardsAfter = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "zettel")));
    expect(cardsAfter).toHaveLength(1);
  });
});
