import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Q03 (ASH-134) dispatcher invariants against real Postgres: a crash between
 * commit and publish loses no intent, an accepted publish with a lost
 * response redelivers without a second effect, a dead worker's lease is
 * recovered by the next dispatcher, and a poison row dead-letters instead of
 * retrying forever.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let client: NonNullable<typeof handle>["client"];
let outbox: typeof import("@/domains/audit/outbox");

beforeAll(async () => {
  if (!handle) return;
  ({ db, client } = handle);
  outbox = await import("@/domains/audit/outbox");
});

afterAll(async () => {
  await handle?.client.end();
});

async function enqueue(slug: string, dispatchKey?: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `outbox-${slug}-${Date.now()}`);
  const auth = ownerAuth(userId, workspaceId);
  const result = await db.transaction(async (tx) =>
    outbox.enqueueOutbox(tx, auth, {
      topic: "test.ping",
      payload: { n: 1 },
      dispatchKey,
    }),
  );
  return { workspaceId, id: result.id!, enqueued: result.enqueued };
}

const row = async (id: string) => db.select().from(outboxEvents).where(eq(outboxEvents.id, id)).then((r) => r[0]);

suite("outbox dispatcher (Q03)", () => {
  it("a dispatch-keyed enqueue is idempotent within a workspace", async () => {
    const { workspaceId } = await enqueue("dedupe-seed");
    const key = `key-${Date.now()}`;
    const publish = () =>
      db.transaction(async (tx) =>
        outbox.enqueueOutbox(tx, { workspaceId }, { topic: "test.ping", payload: { n: 1 }, dispatchKey: key }),
      );
    const first = await publish();
    const second = await publish();
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.id).toBeNull();
    // Another workspace with the same key is a different identity.
    const other = await enqueue("dedupe-other", key);
    expect(other.enqueued).toBe(true);
  });

  it("commit-before-publish crash: a claimed-then-abandoned row is recovered, not lost", async () => {
    const { id } = await enqueue("crash");
    const claimed = await outbox.claimOutboxBatch(client, { workerId: "worker-a", leaseMs: 60_000 });
    expect(claimed.map((e) => e.id)).toContain(id);
    // The worker dies here: no completion, no failure. The lease expires.
    await client`update outbox_events set lease_expires_at = now() - interval '1 second' where id = ${id}`;
    const released = await outbox.recoverStrandedOutbox(client);
    expect(released).toContain(id);
    const after = await row(id);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0); // a release is not a failure
    expect(after.leaseOwner).toBeNull();
  });

  it("accepted publish with a lost response redelivers without a second effect", async () => {
    const { id } = await enqueue("lost-response");
    const applied = new Set<string>();
    const calls: string[] = [];
    const handler = async (event: { id: string }) => {
      calls.push(event.id);
      applied.add(event.id); // the handler's own idempotency: redelivery is a no-op
      if (calls.length === 1) {
        // The publish happened, but the completion write never does (lost
        // response): the claim simply lapses.
        await client`update outbox_events set lease_expires_at = now() - interval '1 second' where id = ${event.id}`;
        throw new Error("connection dropped after the provider accepted");
      }
    };
    await expect(
      outbox.dispatchPendingOutbox(client, { "test.ping": handler }, { workerId: "worker-b" }),
    ).resolves.toMatchObject({ claimed: 1, failed: 1 });
    await outbox.recoverStrandedOutbox(client);
    const second = await outbox.dispatchPendingOutbox(client, { "test.ping": handler }, { workerId: "worker-c" });
    expect(second).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(calls).toHaveLength(2); // delivered twice
    expect(applied.size).toBe(1); // effected once
    expect((await row(id)).status).toBe("dispatched");
  });

  it("a stale worker cannot complete or fail a row it lost", async () => {
    const { id } = await enqueue("stale");
    const [event] = await outbox.claimOutboxBatch(client, { workerId: "worker-d", leaseMs: 60_000 });
    expect(event.id).toBe(id);
    // The lease is reclaimed by a restart: the old token must fence nothing.
    await outbox.recoverStrandedOutbox(client);
    await client`update outbox_events set lease_expires_at = now() - interval '1 second' where id = ${id}`;
    await outbox.recoverStrandedOutbox(client);
    await expect(outbox.completeOutbox(client, { id, leaseToken: event.leaseToken })).rejects.toThrow(
      outbox.OutboxStaleWriteError,
    );
    await expect(
      outbox.failOutbox(client, { id, leaseToken: event.leaseToken, error: "late" }),
    ).rejects.toThrow(outbox.OutboxStaleWriteError);
    expect((await row(id)).status).toBe("pending");
  });

  it("a poison row dead-letters at the attempt ceiling with its error", async () => {
    const { id } = await enqueue("poison");
    const handler = async () => {
      throw new Error("always broken");
    };
    for (let attempt = 1; attempt <= outbox.OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await client`update outbox_events set available_at = now() - interval '1 second' where id = ${id}`;
      await outbox.dispatchPendingOutbox(client, { "test.ping": handler }, { workerId: `worker-p${attempt}` });
    }
    const after = await row(id);
    expect(after.status).toBe("dead");
    expect(after.attempts).toBe(outbox.OUTBOX_MAX_ATTEMPTS);
    expect(after.lastError).toBe("always broken");
    // A dead row is never claimed again.
    const claimed = await outbox.claimOutboxBatch(client, { workerId: "worker-pz" });
    expect(claimed.map((e) => e.id)).not.toContain(id);
  });

  it("an unhandled topic releases the claim without spending an attempt", async () => {
    const { id } = await enqueue("unhandled");
    const result = await outbox.dispatchPendingOutbox(client, {}, { workerId: "worker-none" });
    expect(result.claimed).toBe(1);
    const after = await row(id);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);
    expect(after.leaseOwner).toBeNull();
  });
});
