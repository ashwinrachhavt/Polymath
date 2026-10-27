import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxParkError } from "@/domains/audit/outbox";
import { outboxEvents } from "@/domains/audit/schema";
import { captureProposals, captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Parking against the real enrichment handler (ASH-305): the proposals a run
 * writes are idempotent under duplicate delivery, a run parked mid-flight still
 * finishes with its proposals hidden from EVERY consumer until unpark, and the
 * park -> claimed-return -> unpark race and crash retry leave one set of
 * proposals. The judger is a fake; no provider is called.
 */

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
let enrichment: typeof import("@/domains/capture/enrichment-handler");
let parking: typeof import("@/domains/capture/parking");
let queries: typeof import("@/domains/capture/queries");
let home: typeof import("@/domains/home/queue");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = handle.db;
  enrichment = await import("@/domains/capture/enrichment-handler");
  parking = await import("@/domains/capture/parking");
  queries = await import("@/domains/capture/queries");
  home = await import("@/domains/home/queue");
});

afterAll(async () => {
  await handle?.client.end();
});

const PROSE = "A thought about how the quarterly planning should be restructured around fewer, larger bets. ".repeat(5);

async function seed(tag: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `parking-${tag}-${Date.now()}`);
  const [capture] = await db
    .insert(captures)
    .values({
      workspaceId,
      kind: "text",
      captureMode: "authored",
      rawPayload: { text: PROSE },
      text: PROSE,
    })
    .returning();
  return { auth: ownerAuth(userId, workspaceId), workspaceId, capture };
}

/** An unreadable Jev answer files exactly one low-confidence note proposal per successful run. */
const judger = (onJudge?: () => Promise<void>) => ({
  calls: 0,
  async judge() {
    this.calls += 1;
    await onJudge?.();
    return { answers: {}, model: "fake-jev" };
  },
});

const event = (workspaceId: string, captureId: string) =>
  ({
    id: crypto.randomUUID(),
    workspaceId,
    topic: "capture.enrichment_requested",
    payload: { captureId },
  }) as never;

const proposalsOf = (captureId: string) =>
  db.select().from(captureProposals).where(eq(captureProposals.captureId, captureId));

suite("capture parking and enrichment idempotency", () => {
  it("forced overlap: the second run is parked behind the lease, the model is called exactly once, one set of proposals", async () => {
    const { workspaceId, capture } = await seed("overlap");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inModelCall = new Promise<void>((resolve) => (entered = resolve));
    const a = judger(async () => {
      entered();
      await gate;
    });
    const b = judger();
    const runA = enrichment.runCaptureEnrichment(event(workspaceId, capture.id), { judger: a as never });
    await inModelCall;
    await expect(
      enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
        judger: b as never,
      }),
    ).rejects.toBeInstanceOf(OutboxParkError);
    release();
    await runA;
    // Redelivery after A finished: nothing left to do.
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: b as never,
    });
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row).toMatchObject({
      processingState: "enriched",
      enrichmentLeaseToken: null,
      enrichmentLeaseUntil: null,
    });
  });

  it("an expired holder is fenced out: it cannot finalize, regress or clear the newer holder's work", async () => {
    const { workspaceId, capture } = await seed("stale");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inModelCall = new Promise<void>((resolve) => (entered = resolve));
    const stale = judger(async () => {
      entered();
      await gate;
    });
    const fresh = judger();
    const runStale = enrichment.runCaptureEnrichment(event(workspaceId, capture.id), { judger: stale as never });
    await inModelCall;
    // The lease expires (the holder stalled past it).
    await db
      .update(captures)
      .set({ enrichmentLeaseUntil: new Date(Date.now() - 1000) })
      .where(eq(captures.id, capture.id));
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: fresh as never,
    });
    expect(fresh.calls).toBe(1);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
    const [done] = await db.select().from(captures).where(eq(captures.id, capture.id));
    // The stale holder finally returns: its CAS matches no row, files nothing, changes nothing.
    release();
    await runStale;
    expect(stale.calls).toBe(1);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
    const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(after.processingState).toBe("enriched");
    expect(after.updatedAt).toEqual(done.updatedAt);
  });

  it("a provider error releases the lease so the redelivery runs immediately", async () => {
    const { workspaceId, capture } = await seed("release");
    const failing = {
      calls: 0,
      async judge() {
        this.calls += 1;
        throw new Error("provider down");
      },
    };
    await expect(
      enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
        judger: failing as never,
      }),
    ).rejects.toThrow("provider down");
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.enrichmentLeaseToken).toBeNull();
    const ok = judger();
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: ok as never,
    });
    expect(ok.calls).toBe(1);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
  });

  it("crash: a dead holder's lease blocks the redelivery only until it expires, then recovery runs once", async () => {
    const { workspaceId, capture } = await seed("crash-lease");
    await db
      .update(captures)
      .set({
        processingState: "classifying",
        enrichmentLeaseToken: crypto.randomUUID(),
        enrichmentLeaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(captures.id, capture.id));
    const j = judger();
    await expect(
      enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
        judger: j as never,
      }),
    ).rejects.toBeInstanceOf(OutboxParkError);
    expect(j.calls).toBe(0);
    await db
      .update(captures)
      .set({ enrichmentLeaseUntil: new Date(Date.now() - 1000) })
      .where(eq(captures.id, capture.id));
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: j as never,
    });
    expect(j.calls).toBe(1);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
  });

  it("crash recovery still works: a capture left classifying is finished by the redelivered event", async () => {
    const { workspaceId, capture } = await seed("crash");
    await db.update(captures).set({ processingState: "classifying" }).where(eq(captures.id, capture.id));
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: judger() as never,
    });
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("enriched");
    expect(await proposalsOf(capture.id)).toHaveLength(1);
  });

  it("a run parked mid-flight finishes, and its proposals stay hidden from every consumer until unpark", async () => {
    const { auth, workspaceId, capture } = await seed("midflight");
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: judger(async () => {
        await parking.parkCapture(auth, {
          captureId: capture.id,
          expectedVersion: capture.version,
        });
      }) as never,
    });
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("enriched");
    expect(row.parkedAt).not.toBeNull();
    expect(await proposalsOf(capture.id)).toHaveLength(1);

    expect(await queries.listPendingCaptureProposals(auth, capture.id)).toHaveLength(0);
    expect((await queries.listCapturesWithPendingProposals(auth, [capture.id])).size).toBe(0);
    expect((await home.listHomeQueue(workspaceId)).filter((card) => card.origin === "capture")).toHaveLength(0);

    const [settled] = await db.select().from(captures).where(eq(captures.id, capture.id));
    await parking.unparkCapture(auth, {
      captureId: capture.id,
      expectedVersion: settled.version,
    });
    expect(await queries.listPendingCaptureProposals(auth, capture.id)).toHaveLength(1);
    expect((await queries.listCapturesWithPendingProposals(auth, [capture.id])).size).toBe(1);
    expect((await home.listHomeQueue(workspaceId)).filter((card) => card.origin === "capture")).toHaveLength(1);
  });

  it("park, then the claimed event returns early, then unpark: the paused work runs once and proposals are not doubled", async () => {
    const { auth, workspaceId, capture } = await seed("race");
    // The original event is claimed (leased) and still 'pending' when unpark runs.
    const [original] = await db
      .insert(outboxEvents)
      .values({
        workspaceId,
        topic: "capture.enrichment_requested",
        payload: { captureId: capture.id },
        dispatchKey: `capture-enrichment:${capture.id}`,
        leaseOwner: "worker-1",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const parked = await parking.parkCapture(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    // The claimed run sees the park and returns without touching anything.
    await enrichment.runCaptureEnrichment(original as never, {
      judger: judger() as never,
    });
    expect(await proposalsOf(capture.id)).toHaveLength(0);
    // Unpark lands before the worker marks the event dispatched.
    await parking.unparkCapture(auth, {
      captureId: capture.id,
      expectedVersion: parked.version,
    });
    const queued = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "capture.enrichment_requested")));
    expect(queued).toHaveLength(2);
    // Both now deliver, in either order: the CAS leaves one set of proposals.
    const j = judger();
    for (const e of queued) await enrichment.runCaptureEnrichment(e as never, { judger: j as never });
    expect(j.calls).toBe(1);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
  });

  it("unpark of an enriched capture enqueues nothing and leaves it exactly as it was", async () => {
    const { auth, workspaceId, capture } = await seed("enriched");
    await enrichment.runCaptureEnrichment(event(workspaceId, capture.id), {
      judger: judger() as never,
    });
    const [enriched] = await db.select().from(captures).where(eq(captures.id, capture.id));
    const parked = await parking.parkCapture(auth, {
      captureId: capture.id,
      expectedVersion: enriched.version,
    });
    await parking.unparkCapture(auth, {
      captureId: capture.id,
      expectedVersion: parked.version,
    });
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId))).toHaveLength(0);
    expect(await proposalsOf(capture.id)).toHaveLength(1);
  });
});
