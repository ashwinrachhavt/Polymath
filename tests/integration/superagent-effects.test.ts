import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Later,
  type ClaimedEffect,
  type ClaimedReceipt,
  type EffectHandler,
  type ReceiptSender,
  claimDueEffects,
  claimPendingReceipts,
  completeEffect,
  conversationReplyHandler,
  deferEffect,
  recoverStrandedEffects,
  recoverStrandedReceipts,
  runEffectsPass,
  runReceiptsPass,
  runSuperagentDispatch,
} from "@/domains/superagent/effects";
import { attentionEffects, createSuperagentStore, dueEffects, pendingReceipts } from "@/domains/superagent/store";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The effects queue and the reply lane against real Postgres: coalescing per
 * (kind, key), the lease-fenced claim/complete/fail/defer mechanics, the
 * three-strikes health entry, the Later defer that counts no failure, and the
 * receipts lane's per-conversation ordering with exactly-once sends. Each
 * scenario seeds its own workspace (unique slugs, no truncation) and owns the
 * whole queue for a moment — the db project runs files serially, so the
 * beforeEach delete below cannot race another file.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let client: NonNullable<typeof handle>["client"];

beforeAll(async () => {
  if (!handle) return;
  ({ db, client } = handle);
});

afterAll(async () => {
  await handle?.client.end();
});

beforeEach(async () => {
  // Each scenario owns the whole queue for the moment it runs: a prior test's
  // pending row would be claimed by the next pass and muddy the counts.
  await db.execute(sql`delete from work_effects`);
  await db.execute(sql`delete from work_outbox_receipts`);
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const channel = (thread: string, message: string) => ({ source: "chat", thread, address: { message } });

async function seedStore(slug: string) {
  const { workspaceId } = await seedWorkspace(db, `effects-${slug}-${Date.now()}`);
  const store = createSuperagentStore(db, workspaceId);
  await store.hydrate();
  return { store, workspaceId };
}

/** Shifts due time forward for one workspace's rows, simulating the clock between passes. */
const becomeDue = (workspaceId: string) =>
  client`update work_effects set available_at = now() - interval '1 second' where workspace_id = ${workspaceId}`;
const receiptsLeaseExpired = (workspaceId: string) =>
  client`update work_outbox_receipts set lease_expires_at = now() - interval '1 second' where workspace_id = ${workspaceId}`;

const effectRow = async (id: string) =>
  (
    await client<{ available_at: string; attempts: number; consecutive_failures: number; last_error: string | null }[]>`
      select available_at::text as available_at, attempts, consecutive_failures, last_error from work_effects where id = ${id}
    `
  )[0];

const receiptRow = async (id: string) =>
  (await client<{ status: string }[]>`select status from work_outbox_receipts where id = ${id}`)[0];

/** A sender that records every call's message id and can be told to throw once per id. */
function scriptedSender(failIds: string[] = []) {
  const sent: string[] = [];
  const sender: ReceiptSender = async (message) => {
    if (failIds.includes(message.id)) {
      failIds.splice(failIds.indexOf(message.id), 1); // fail once, then succeed
      throw new Error(`send of ${message.id} failed`);
    }
    sent.push(message.id);
    return "sent";
  };
  return { sender, sent };
}

suite("superagent effects queue", () => {
  it("commits the effect with the command and coalesces pending (kind, key)", async () => {
    const { store, workspaceId } = await seedStore("coalesce");
    store.effects.enqueue({ kind: "launch", key: "ticket-1" });
    store.effects.enqueue({ kind: "launch", key: "ticket-1" }); // same key inside one command
    store.effects.enqueue({ kind: "assessment", key: "trigger-1" });
    await store.flush();
    expect(await dueEffects(db, workspaceId, new Date())).toHaveLength(2);

    // A second process enqueues the same pair: the pending row swallows it.
    const second = createSuperagentStore(db, workspaceId);
    await second.hydrate();
    second.effects.enqueue({ kind: "launch", key: "ticket-1" });
    await second.flush();
    expect(await dueEffects(db, workspaceId, new Date())).toHaveLength(2);

    // The drained row stops blocking: claim both, complete one, enqueue again —
    // only the drained key re-queues; the pending one still coalesces.
    const claimed = await claimDueEffects(client, { workerId: "spec" });
    expect(claimed).toHaveLength(2);
    const launch = claimed.find((c) => c.key === "ticket-1")!;
    await completeEffect(client, { id: launch.id, leaseToken: launch.leaseToken });
    const third = createSuperagentStore(db, workspaceId);
    await third.hydrate();
    third.effects.enqueue({ kind: "launch", key: "ticket-1" });
    await third.flush();
    const keys = (await dueEffects(db, workspaceId, new Date())).map((r) => r.key).sort();
    expect(keys).toEqual(["ticket-1", "trigger-1"]);
  });

  it("fences queue writes on the lease token and rejects stale ones", async () => {
    const { store, workspaceId } = await seedStore("fence");
    store.effects.enqueue({ kind: "launch", key: "ticket-9" });
    await store.flush();

    const claimed = await claimDueEffects(client, { workerId: "worker-a" });
    expect(claimed).toHaveLength(1);
    // A leased row is not claimable, not even scoped to its own workspace.
    expect(await claimDueEffects(client, { workerId: "worker-b", workspaceId })).toHaveLength(0);

    await expect(
      completeEffect(client, { id: claimed[0]!.id, leaseToken: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/moved on/);
    await completeEffect(client, { id: claimed[0]!.id, leaseToken: claimed[0]!.leaseToken });
    const after = await effectRow(claimed[0]!.id);
    expect(after?.attempts).toBe(0); // success is not an attempt
  });

  it("keeps a failing effect pending, backs it off, and raises health after three", async () => {
    const { store, workspaceId } = await seedStore("health");
    store.effects.enqueue({ kind: "delivery", key: "run-1" });
    await store.flush();
    const failing: EffectHandler = async () => {
      throw new Error("the provider is down");
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pass = await runEffectsPass(client, { delivery: failing }, { workerId: "spec", random: () => 0.999 });
      expect(pass).toEqual({ claimed: 1, done: 0, deferred: 0, failed: 1 });
      if (attempt < 3) await becomeDue(workspaceId); // let the backoff elapse
    }
    const [row] = await attentionEffects(db, workspaceId);
    expect(row?.key).toBe("run-1");
    expect(row?.lastError).toBe("the provider is down");
    // Still pending: the queue never dead-letters.
    const stored = await effectRow(row.id);
    expect(stored?.attempts).toBe(3);
    expect(stored?.consecutive_failures).toBe(3);
  });

  it("a Later defer parks the effect without counting a failure", async () => {
    const { store, workspaceId } = await seedStore("later");
    store.effects.enqueue({ kind: "delivery", key: "run-2" });
    await store.flush();

    const pass = await runEffectsPass(
      client,
      { delivery: async () => Promise.reject(new Later(5_000, "not yet")) },
      { workerId: "spec" },
    );
    expect(pass).toEqual({ claimed: 1, done: 0, deferred: 1, failed: 0 });
    expect(await dueEffects(db, workspaceId, new Date(Date.now() + 6_000))).toHaveLength(1);
    const row = (await dueEffects(db, workspaceId, new Date(Date.now() + 6_000)))[0];
    // Parked ~5s out, not immediately due again, and no failure counted.
    const stored = await effectRow(row.id);
    expect(new Date(stored!.available_at).getTime()).toBeGreaterThan(Date.now() + 3_000);
    expect(stored!.consecutive_failures).toBe(0);
  });

  it("a kind whose consumer has not deployed parks without failure", async () => {
    const { store, workspaceId } = await seedStore("handlerless");
    store.effects.enqueue({ kind: "relay", key: "conversation-1" });
    await store.flush();

    const pass = await runEffectsPass(client, {}, { workerId: "spec" });
    expect(pass).toEqual({ claimed: 1, done: 0, deferred: 1, failed: 0 });
    expect(await dueEffects(db, workspaceId, new Date(Date.now() + 60_000))).toHaveLength(1);
    const row = (await dueEffects(db, workspaceId, new Date(Date.now() + 60_000)))[0];
    const stored = await effectRow(row.id);
    expect(new Date(stored!.available_at).getTime()).toBeGreaterThan(Date.now() + 3_000); // ~DEFAULT_PARK_MS
    expect(stored!.consecutive_failures).toBe(0);
  });
});

suite("superagent reply lane (outbox receipts)", () => {
  it("sends a conversation's receipts in order, once each, through the reply effect", async () => {
    const { store, workspaceId } = await seedStore("ordered");
    const ch = channel("t1", "m-1");
    store.outbox.send({ id: "m-1", channel: ch, text: "first", kind: "reply" });
    store.outbox.send({ id: "m-2", channel: ch, text: "second", kind: "notice" });
    await store.flush();
    // One reply effect for the conversation, two pending receipts.
    expect(await pendingReceipts(db, workspaceId)).toHaveLength(2);
    const { sender, sent } = scriptedSender();
    const pass = await runEffectsPass(
      client,
      { reply: conversationReplyHandler(client, sender) },
      { workerId: "spec" },
    );
    expect(pass.done).toBe(1);
    expect(sent).toEqual(["m-1", "m-2"]);
    expect((await receiptRow("m-1"))?.status).toBe("sent");
    expect((await receiptRow("m-2"))?.status).toBe("sent");

    // Exactly-once: another pass sends nothing new, and the drained conversation is quiet.
    const again = await runEffectsPass(
      client,
      { reply: conversationReplyHandler(client, sender) },
      { workerId: "spec" },
    );
    expect(again.done).toBe(0);
    expect(sent).toEqual(["m-1", "m-2"]);
  });

  it("never queues an id twice, even across processes", async () => {
    const { store, workspaceId } = await seedStore("send-once");
    const ch = channel("t1", "m-1");
    store.outbox.send({ id: "m-1", channel: ch, text: "first", kind: "reply" });
    await store.flush();
    const { sender, sent } = scriptedSender();
    await runEffectsPass(client, { reply: conversationReplyHandler(client, sender) }, { workerId: "spec" });

    // A fresh process re-sends the same id: the primary key keeps one row, already sent.
    const second = createSuperagentStore(db, workspaceId);
    await second.hydrate();
    second.outbox.send({ id: "m-1", channel: ch, text: "first", kind: "reply" });
    await second.flush();
    expect(await pendingReceipts(db, workspaceId)).toHaveLength(0);
    const again = await runEffectsPass(
      client,
      { reply: conversationReplyHandler(client, sender) },
      { workerId: "spec" },
    );
    expect(again.done).toBe(0);
    expect(sent).toEqual(["m-1"]);
  });

  it("a send that throws stops the conversation and recovers in order", async () => {
    const { store, workspaceId } = await seedStore("recover");
    const ch = channel("t1", "m-1");
    for (const [id, text] of [
      ["m-1", "one"],
      ["m-2", "two"],
      ["m-3", "three"],
    ] as const) {
      store.outbox.send({ id, channel: ch, text, kind: "reply" });
    }
    await store.flush();

    const { sender, sent } = scriptedSender(["m-2"]);
    await runEffectsPass(client, { reply: conversationReplyHandler(client, sender) }, { workerId: "spec" });
    // m-1 landed; m-2 failed once; m-3 was never attempted — order protects it.
    expect(sent).toEqual(["m-1"]);
    expect((await receiptRow("m-2"))?.status).toBe("pending");

    // The failure grew the reply effect's counters (first strike, not health yet).
    const [effect] = await dueEffects(db, workspaceId, new Date(Date.now() + 301_000));
    const effectRow_ = await effectRow(effect.id);
    expect(effectRow_?.consecutive_failures).toBe(1);

    // The worker died before the retry: the sweep releases the expired leases,
    // and the next pass finishes the conversation in order.
    await receiptsLeaseExpired(workspaceId);
    const released = await recoverStrandedReceipts(client);
    expect(released).toHaveLength(2);
    await runReceiptsPass(client, sender, { workerId: "spec", workspaceId });
    expect(sent).toEqual(["m-1", "m-2", "m-3"]);
    expect((await receiptRow("m-3"))?.status).toBe("sent");
  });

  it("never splits a conversation whose head holds a live lease", async () => {
    const { store, workspaceId } = await seedStore("prefix");
    const ch = channel("t1", "m-1");
    store.outbox.send({ id: "m-1", channel: ch, text: "held", kind: "reply" });
    store.outbox.send({ id: "m-9", channel: channel("t2", "m-9"), text: "other conversation", kind: "reply" });
    await store.flush();

    // Another pass holds conversation t1's head under a fresh lease.
    const held = await claimPendingReceipts(client, { workerId: "worker-a", workspaceId, conversation: "chat:t1" });
    expect(held.map((r) => r.id)).toEqual(["m-1"]);

    // The pass takes t2 only: t1's head is leased and the guard blocks the split.
    const { sender, sent } = scriptedSender();
    const pass = await runReceiptsPass(client, sender, { workerId: "spec", workspaceId });
    expect(pass.sent).toBe(1); // t2 only — t1's head is leased and the guard blocks the split
    expect(sent).toEqual(["m-9"]);

    // Sweep releases the dead holder; the conversation is sendable again.
    await receiptsLeaseExpired(workspaceId);
    expect((await recoverStrandedReceipts(client)).length).toBe(1);
  });

  it("drops a withdrawn receipt without sending it", async () => {
    const { store, workspaceId } = await seedStore("gone");
    const ch = channel("t1", "m-1");
    store.outbox.send({ id: "m-1", channel: ch, text: "kept", kind: "reply" });
    store.outbox.send({ id: "m-2", channel: ch, text: "gone", kind: "notice" });
    store.outbox.withdraw("m-2");
    await store.flush();

    const { sender, sent } = scriptedSender();
    await runReceiptsPass(client, sender, { workerId: "spec", workspaceId });
    expect(sent).toEqual(["m-1"]);
    expect((await receiptRow("m-2"))?.status).toBe("dropped");
  });

  it("runSuperagentDispatch sweeps, drains both lanes, and reports the counts", async () => {
    const { store, workspaceId } = await seedStore("dispatch");
    const ch = channel("t1", "m-1");
    store.outbox.send({ id: "m-1", channel: ch, text: "hello", kind: "reply" });
    store.effects.enqueue({ kind: "launch", key: "ticket-5" }); // handlerless in this pass
    await store.flush();

    const { sender, sent } = scriptedSender();
    const result = await runSuperagentDispatch(
      client,
      { reply: conversationReplyHandler(client, sender) },
      { workerId: "spec", workspaceId, random: () => 0.999 },
    );
    expect(result.strandedEffects).toBe(0);
    expect(result.strandedReceipts).toBe(0);
    expect(result.effects).toEqual({ claimed: 2, done: 1, deferred: 1, failed: 0 });
    expect(sent).toEqual(["m-1"]);
  });

  it("sweeps a worker that died between claim and completion without a failure", async () => {
    const { store } = await seedStore("stranded");
    store.effects.enqueue({ kind: "launch", key: "ticket-7" });
    await store.flush();
    const [claimed] = await claimDueEffects(client, { workerId: "worker-a", leaseMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 60)); // the lease expires under the dead worker
    const released = await recoverStrandedEffects(client);
    expect(released).toEqual([claimed!.id]);
    const row = await effectRow(claimed!.id);
    expect(row?.attempts).toBe(0); // a release is not a failure
    expect(row?.consecutive_failures).toBe(0);
    // And the row is claimable again.
    expect(await claimDueEffects(client, { workerId: "worker-b" })).toHaveLength(1);
  });

  it("defers a claimed effect to an explicit retry time", async () => {
    const { store } = await seedStore("defer");
    store.effects.enqueue({ kind: "notice", key: "n-1" });
    await store.flush();
    const [claimed] = await claimDueEffects(client, { workerId: "spec" });
    await deferEffect(client, {
      id: claimed!.id,
      leaseToken: claimed!.leaseToken,
      retryAt: new Date(Date.now() + 60_000),
    });
    // Not due again for a minute, and untouched counters.
    expect(await claimDueEffects(client, { workerId: "spec" })).toHaveLength(0);
    const row = await effectRow(claimed!.id);
    expect(row?.attempts).toBe(0);
  });
});

/* Type-level smoke: the claimed shapes carry what the consumers need. */
suite("claimed shapes", () => {
  it("a claimed effect and receipt expose the fields the consumers use", () => {
    const claimed: ClaimedEffect = {
      id: "e-1",
      workspaceId: "w-1",
      kind: "launch",
      key: "ticket-1",
      payload: null,
      attempts: 0,
      consecutiveFailures: 0,
      leaseToken: "t",
    };
    const receipt: ClaimedReceipt = {
      id: "m-1",
      workspaceId: "w-1",
      leaseToken: "t",
      text: "hi",
      kind: "reply",
      channel: channel("t1", "m-1"),
      ticketId: null,
      seq: 1,
    };
    expect(claimed.kind).toBe("launch");
    expect(receipt.channel.source).toBe("chat");
  });
});
