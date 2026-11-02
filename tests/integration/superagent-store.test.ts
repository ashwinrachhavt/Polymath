import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEngine,
  key,
  type Assessor,
  type Candidate,
  type Executor,
  type OutboundMessage,
  type Policy,
  type Ticket,
  type Trigger,
} from "@/domains/superagent/core";
import {
  activeTickets,
  activeThreads,
  attentionEffects,
  createSuperagentStore,
  dueEffects,
  getPolicy,
  openTickets,
  pendingReceipts,
  runsForTicket,
  savePolicy,
  ticketsForThread,
  workAssessments,
  workEffects,
} from "@/domains/superagent/store";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The superagent store against real Postgres: every repository method, the
 * outbox receipt lane, the generated columns the dispatch passes read, and the
 * flush's compare-and-set discipline. Each scenario seeds its own workspace
 * (unique slugs, no truncation) and proves persistence by reopening a fresh
 * store — the same way a later request or serverless invocation would.
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

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const member = { source: "chat", id: "alice" };
const channel = { source: "chat", thread: "t1", address: { message: "m1" } };
const base: Omit<Trigger, "id" | "text" | "at"> = {
  source: "chat",
  threads: [{ source: "chat", id: "t1" }],
  actor: member,
  human: true,
  channel,
  meta: {},
};

function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { ...base, id, at: "2026-09-23T00:00:00.000Z", text: `message ${id}`, ...overrides };
}

function policy(): Policy {
  return {
    version: "v1",
    paused: false,
    evalTimeoutMs: 60_000,
    gate: (t) =>
      t.actor.id === "alice"
        ? { admissible: true, strength: "explicit", basis: { via: "listed" } }
        : { admissible: false, reason: "not a member" },
    revalidate: () => true,
    admitsInferred: (rules) => rules.length > 0,
  };
}

function stubs() {
  const requests: Candidate[] = [];
  const assessor: Assessor = { request: vi.fn((candidate) => requests.push(candidate)), release: vi.fn() };
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() };
  return { requests, assessor, executor };
}

// Core ids are content-derived: equal inputs give equal ids. Fresh rows need
// fresh ids, so tests derive theirs from a per-run counter.
let uidSeq = 0;
const uid = () => key(`store-test-${Date.now()}-${++uidSeq}`);

/** A store plus a real engine over it; `run` wraps one command in atomic + flush. */
let rigSeq = 0;
async function rig(slug: string) {
  const { workspaceId } = await seedWorkspace(db, `superagent-${slug}-${++rigSeq}-${Date.now()}`);
  const store = createSuperagentStore(db, workspaceId);
  await store.hydrate();
  const { assessor, executor, requests } = stubs();
  const engine = createEngine({
    repo: store.repositories,
    policy,
    scope: {
      scope: (input) =>
        input.meta.blocked ? { listened: false, reason: "chat not allowed" } : { listened: true, observed: false },
    },
    assessor,
    executor,
    outbox: store.outbox,
  });
  return {
    workspaceId,
    store,
    engine,
    requests,
    executor,
    run: async <T>(work: () => T): Promise<T> => {
      const result = store.repositories.atomic(work);
      await store.flush();
      return result;
    },
  };
}

/** A fresh store over the same workspace, hydrated — what a later request sees. */
async function reopen(workspaceId: string) {
  const store = createSuperagentStore(db, workspaceId);
  await store.hydrate();
  return store;
}

const accept = {
  kind: "accept" as const,
  title: "Fix",
  scope: "small",
  reason: "requested",
  acknowledgement: "ok",
};

beforeEach(() => {
  vi.clearAllMocks();
});

function bareTicket(id: string): Ticket {
  return {
    id,
    title: `T ${id}`,
    decisionId: "d",
    mandate: { strength: "explicit", policyVersion: "v1", basis: { via: "listed" }, actor: member, scope: "s" },
    channels: [],
    runs: [],
    inputs: [],
    undelivered: [],
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    origin: { triggerId: "trig-0", triggerIds: ["trig-0"] },
  };
}

suite("superagent store", () => {
  it("round-trips a trigger and its disposition through a flush and a rehydrate", async () => {
    const r = await rig("trigger");
    const t = trigger(uid(), { url: "https://chat.example/t1/m1", meta: { nested: { depth: 2 } } });
    await r.run(() => r.store.repositories.triggers.save(t));
    await r.run(() =>
      r.store.repositories.triggers.saveDisposition(t.id, { fanout: [], at: "2026-09-23T00:00:01.000Z" }),
    );

    const reopened = await reopen(r.workspaceId);
    expect(reopened.repositories.triggers.get(t.id)).toEqual(t);
    expect(reopened.repositories.triggers.disposition(t.id)).toEqual({ fanout: [], at: "2026-09-23T00:00:01.000Z" });
    expect(reopened.repositories.triggers.get(key("never-saved"))).toBeUndefined();
  });

  it("stores a trigger once and records source filtering, like the engine's intake", async () => {
    const r = await rig("intake");
    const t = trigger(uid(), { meta: { blocked: true } });
    await r.run(() => r.engine.receive(t));
    // The core's disposition shape: when it did not listen, why — so the
    // panel can explain the drop without re-reading the source.
    expect(r.store.repositories.triggers.disposition(t.id)).toMatchObject({
      fanout: [],
      filtered: { code: "chat not allowed" },
    });
    // A filtered trigger is still stored — the panel explains why it was dropped.
    const reopened = await reopen(r.workspaceId);
    expect(reopened.repositories.triggers.get(t.id)).toEqual(t);
  });

  it("folds subscriptions and context back into a thread in order", async () => {
    const r = await rig("thread");
    // Subscriptions reference tickets, so the bound tickets exist first.
    const ticketB = bareTicket(uid());
    const ticketA = bareTicket(uid());
    const ticketC = bareTicket(uid());
    await r.run(() => {
      r.store.repositories.tickets.save(ticketB);
      r.store.repositories.tickets.save(ticketA);
      r.store.repositories.tickets.save(ticketC);
    });
    const thread = {
      key: uid(),
      ref: { source: "chat", id: "conv-1" },
      createdAt: "2026-09-23T00:00:00.000Z",
      lastAt: "2026-09-23T00:00:05.000Z",
      subscriptions: [ticketB.id, ticketA.id],
      context: [ticketC.id],
      correlated: [],
      pending: ["trig-1"],
      meta: { facts: { topic: "deploy" } },
    };
    await r.run(() => r.store.repositories.threads.save(thread));

    const reopened = await reopen(r.workspaceId);
    expect(reopened.repositories.threads.get(thread.key)).toEqual(thread);
    // An empty projection and an absent context are the same state.
    const bare = { ...thread, key: uid(), subscriptions: [], context: undefined, pending: [] };
    await r.run(() => r.store.repositories.threads.save(bare));
    const second = await reopen(r.workspaceId);
    expect(second.repositories.threads.get(bare.key)).toEqual({ ...bare, context: undefined });
    expect(second.repositories.threads.list()).toHaveLength(2);
    expect(second.repositories.threads.active().map((t) => t.key)).toEqual([thread.key]);
  });

  it("mirrors the assessment while a thread evaluates and closes it when the thread moves on", async () => {
    const r = await rig("assessment");
    const evaluating = {
      id: key(),
      threadKey: "t-1",
      triggerIds: ["trig-1"],
      primary: "trig-1",
      strength: "explicit" as const,
      actor: member,
      basis: { via: "listed" as const },
      policyVersion: "v1",
      startedAt: "2026-09-23T00:00:00.000Z",
      deadline: "2026-09-23T00:01:00.000Z",
    };
    await r.run(() =>
      r.store.repositories.threads.save({
        key: "t-1",
        ref: { source: "chat", id: "conv-1" },
        createdAt: "2026-09-23T00:00:00.000Z",
        subscriptions: [],
        correlated: [],
        pending: ["trig-1"],
        evaluating,
        meta: {},
      }),
    );
    let rows = await db.select().from(workAssessments).where(eq(workAssessments.workspaceId, r.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endedAt).toBeNull();

    // The thread's eval decided: the mirror row records when it ended.
    await r.run(() =>
      r.store.repositories.threads.save({
        key: "t-1",
        ref: { source: "chat", id: "conv-1" },
        createdAt: "2026-09-23T00:00:00.000Z",
        subscriptions: [],
        correlated: [],
        pending: [],
        expired: 1,
        meta: {},
      }),
    );
    rows = await db.select().from(workAssessments).where(eq(workAssessments.workspaceId, r.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endedAt).not.toBeNull();
  });

  it("keeps tickets newest first in list and open, and preserves run order", async () => {
    const r = await rig("tickets");
    const mk = (id: string): Ticket => ({
      id,
      title: `Ticket ${id}`,
      decisionId: "d1",
      mandate: { strength: "explicit", policyVersion: "v1", basis: { via: "listed" }, actor: member, scope: "small" },
      channels: [],
      runs: [
        {
          id: `${id}-r1`,
          state: "ended",
          createdAt: "2026-09-23T00:00:00.000Z",
          startedAt: "2026-09-23T00:00:01.000Z",
          endedAt: "2026-09-23T00:00:30.000Z",
          report: { state: "ready", summary: "done", at: "2026-09-23T00:00:30.000Z" },
          deliveredAt: "2026-09-23T00:00:31.000Z",
        },
      ],
      inputs: [],
      undelivered: [],
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:31.000Z",
      origin: { triggerId: "trig-1", triggerIds: ["trig-1"] },
    });
    const one = mk(uid());
    const two = {
      ...mk(uid()),
      ended: { at: "2026-09-23T00:01:00.000Z", by: "human" as const, outcome: "completed" as const },
    };
    const three = mk(uid());
    await r.run(() => {
      r.store.repositories.tickets.save(one);
      r.store.repositories.tickets.save(two);
      r.store.repositories.tickets.save(three);
    });

    const reopened = await reopen(r.workspaceId);
    expect(reopened.repositories.tickets.list().map((t) => t.id)).toEqual([three.id, two.id, one.id]);
    expect(reopened.repositories.tickets.open().map((t) => t.id)).toEqual([three.id, one.id]);
    expect(reopened.repositories.tickets.get(one.id)).toEqual(one);
    // The run rows fold back oldest first, in the engine's order.
    const rows = await runsForTicket(db, r.workspaceId, one.id);
    expect(rows.map((row) => row.id)).toEqual([`${one.id}-r1`]);
  });

  it("rolls a throwing command back and persists nothing", async () => {
    const r = await rig("rollback");
    const t = trigger(key());
    expect(() =>
      r.store.repositories.atomic(() => {
        r.store.repositories.triggers.save(t);
        r.store.repositories.threads.save({
          key: "t-1",
          ref: { source: "chat", id: "c1" },
          createdAt: "2026-09-23T00:00:00.000Z",
          subscriptions: [],
          correlated: [],
          pending: [],
          meta: {},
        });
        throw new Error("the assessor blew up");
      }),
    ).toThrow("the assessor blew up");
    await r.store.flush();

    const reopened = await reopen(r.workspaceId);
    expect(reopened.repositories.triggers.get(t.id)).toBeUndefined();
    expect(reopened.repositories.threads.list()).toEqual([]);
  });

  it("fails loudly on a lost version race and never clobbers the outside writer", async () => {
    const r = await rig("race");
    const t = trigger(uid());
    await r.run(() => r.store.repositories.triggers.save(t));

    // An outside writer bumps the row — the sole-writer discipline was violated.
    await client`update work_triggers set text = 'hijacked', version = version + 1 where workspace_id = ${r.workspaceId} and id = ${t.id}`;

    r.store.repositories.triggers.save({ ...t, text: "mine" });
    await expect(r.store.flush()).rejects.toThrow(/changed since it was read/);

    // The cache rolled back to its last persisted state, and the disk still
    // holds the outside writer's row.
    expect(r.store.repositories.triggers.get(t.id)?.text).toBe(t.text);
    const reopened = await reopen(r.workspaceId);
    expect(reopened.repositories.triggers.get(t.id)?.text).toBe("hijacked");
  });

  it("queues an outbox id once, honors withdraw, and never moves a resolved status backwards", async () => {
    const r = await rig("outbox");
    const first: OutboundMessage = { id: "m-1", channel, text: "first", kind: "reply" };
    const second: OutboundMessage = { id: "m-1", channel, text: "second", kind: "reply" };
    r.store.outbox.send(first);
    r.store.outbox.send(second);
    expect(r.store.outbox.status("m-1")).toBe("pending");
    await r.store.flush();

    let rows = await pendingReceipts(db, r.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("first"); // an id queued before keeps its first message

    // A withdrawn message never goes out.
    r.store.outbox.send({ id: "m-2", channel, text: "gone", kind: "notice" });
    r.store.outbox.withdraw("m-2");
    expect(r.store.outbox.status("m-2")).toBe("dropped");
    await r.store.flush();
    rows = await pendingReceipts(db, r.workspaceId);
    expect(rows.map((row) => row.id)).toEqual(["m-1"]);

    // The sender resolves m-1 in Postgres; a stale cache flush cannot unsend it.
    await client`update work_outbox_receipts set status = 'sent', sent_at = now() where workspace_id = ${r.workspaceId} and id = 'm-1'`;
    r.store.outbox.send({ id: "m-1", channel, text: "third", kind: "reply" });
    r.store.outbox.withdraw("m-1");
    await r.store.flush();
    const final =
      await client`select status from work_outbox_receipts where workspace_id = ${r.workspaceId} and id = 'm-1'`;
    expect(final[0]!.status).toBe("sent");
    // And rehydrating reflects the sender's resolution.
    const reopened = await reopen(r.workspaceId);
    expect(reopened.outbox.status("m-1")).toBe("sent");
    expect(reopened.outbox.status("m-2")).toBe("dropped");
  });

  it("drives the real engine across a reopen: receive, evaluate, decide, launch", async () => {
    const r = await rig("flow");
    const t = trigger(uid(), { threads: [{ source: "chat", id: "conv-9" }] });
    await r.run(() => r.engine.receive(t));
    await r.run(() => r.engine.evaluateDue());
    expect(r.requests).toHaveLength(1);

    const candidate = r.requests[0]!;
    const decision = r.engine.decide(candidate.triggers[0]!.id, { ...accept, assessmentId: candidate.assessmentId });
    await r.run(() => decision);
    expect(r.executor.start).toHaveBeenCalledTimes(1);

    const reopened = await reopen(r.workspaceId);
    const [ticket] = reopened.repositories.tickets.list();
    expect(ticket).toBeDefined();
    expect(ticket!.mandate).toEqual({
      strength: "explicit",
      policyVersion: "v1",
      basis: { via: "listed" },
      actor: member,
      scope: "small",
    });
    expect(ticket!.runs).toHaveLength(1);
    // The decision and the closed assessment mirror persisted too.
    const [threadKey] = reopened.repositories.threads.list().map((thread) => thread.key);
    const decisions = reopened.repositories.decisions.byThread(threadKey!);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.ticketId).toBe(ticket!.id);
    const mirrors = await db.select().from(workAssessments).where(eq(workAssessments.workspaceId, r.workspaceId));
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]!.endedAt).not.toBeNull();
  });

  it("reads only active work through the generated columns", async () => {
    const r = await rig("generated");
    // A thread with a queued trigger is active; without one it is not.
    await r.run(() =>
      r.store.repositories.threads.save({
        key: "t-live",
        ref: { source: "chat", id: "c1" },
        createdAt: "2026-09-23T00:00:00.000Z",
        subscriptions: [],
        correlated: [],
        pending: ["trig-1"],
        meta: {},
      }),
    );
    await r.run(() =>
      r.store.repositories.threads.save({
        key: "t-settled",
        ref: { source: "chat", id: "c2" },
        createdAt: "2026-09-23T00:00:00.000Z",
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {},
      }),
    );
    const threadKeys = await activeThreads(db, r.workspaceId);
    expect(threadKeys.map((row) => row.key)).toEqual(["t-live"]);

    // A ticket with undelivered input is active; delivering settles it.
    const ticket: Ticket = {
      id: uid(),
      title: "Wake",
      decisionId: "d",
      mandate: { strength: "explicit", policyVersion: "v1", basis: { via: "listed" }, actor: member, scope: "s" },
      channels: [],
      runs: [
        { id: uid(), state: "running", createdAt: "2026-09-23T00:00:00.000Z", startedAt: "2026-09-23T00:00:01.000Z" },
      ],
      inputs: [],
      undelivered: [],
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:01.000Z",
      origin: { triggerId: "trig-1", triggerIds: ["trig-1"] },
    };
    await r.run(() => r.store.repositories.tickets.save({ ...ticket, undelivered: ["in-1"] }));
    expect((await activeTickets(db, r.workspaceId)).map((row) => row.id)).toEqual([ticket.id]);
    await r.run(() =>
      r.store.repositories.tickets.save({
        ...ticket,
        undelivered: [],
        runs: [{ ...ticket.runs[0]!, state: "ended", endedAt: "2026-09-23T00:00:10.000Z" }],
      }),
    );
    expect((await activeTickets(db, r.workspaceId)).map((row) => row.id)).toEqual([]);
    const open = await openTickets(db, r.workspaceId);
    expect(open.map((row) => row.id)).toEqual([ticket.id]);

    // The fan-out projection answers "which tickets does this thread reach".
    await r.run(() =>
      r.store.repositories.threads.save({
        key: "t-live",
        ref: { source: "chat", id: "c1" },
        createdAt: "2026-09-23T00:00:00.000Z",
        subscriptions: [ticket.id],
        correlated: [],
        pending: [],
        meta: {},
      }),
    );
    expect((await ticketsForThread(db, r.workspaceId, "t-live", "subscription")).map((row) => row.ticketId)).toEqual([
      ticket.id,
    ]);
    expect(await ticketsForThread(db, r.workspaceId, "t-live", "context")).toEqual([]);
  });

  it("coalesces pending effects per (kind, key) and surfaces failures as attention", async () => {
    const r = await rig("effects");
    const effect = { workspaceId: r.workspaceId, id: uid(), kind: "launch", key: "ticket-1", availableAt: new Date() };
    await db.insert(workEffects).values(effect);
    await db
      .insert(workEffects)
      .values({ ...effect, id: uid(), payload: { retry: true } })
      .onConflictDoNothing({
        target: [workEffects.workspaceId, workEffects.kind, workEffects.key],
        where: sql`${workEffects.status} = 'pending'`,
      });
    const all = await db.select().from(workEffects).where(eq(workEffects.workspaceId, r.workspaceId));
    expect(all).toHaveLength(1); // the unique partial index coalesced the retry

    // Not yet available: a backoff row with a future available_at is invisible.
    await db
      .insert(workEffects)
      .values({ ...effect, id: uid(), kind: "delivery", key: "c1", availableAt: new Date(Date.now() + 60_000) });
    expect(await dueEffects(db, r.workspaceId, new Date())).toHaveLength(1);

    // Three consecutive failures raise the health entry, not a dead letter.
    await client`update work_effects set consecutive_failures = 3, last_error = 'boom' where workspace_id = ${r.workspaceId} and kind = 'launch'`;
    const attention = await attentionEffects(db, r.workspaceId);
    expect(attention.map((row) => row.kind)).toEqual(["launch"]);
    expect(attention[0]!.lastError).toBe("boom");
  });

  it("persists the policy document and replaces its rule list", async () => {
    const r = await rig("policy");
    expect(await getPolicy(db, r.workspaceId)).toBeUndefined();

    await savePolicy(
      db,
      r.workspaceId,
      {
        version: "hash-1",
        paused: false,
        acceptMode: "off",
        evalTimeoutMs: 45_000,
        sources: { chat: { allowed: [{ id: "alice", name: "Alice" }] } },
      },
      [
        { id: "r2", name: "Second", instruction: "do b", enabled: true, position: 2 },
        { id: "r1", name: "First", instruction: "do a", enabled: false, position: 1 },
      ],
    );
    const stored = await getPolicy(db, r.workspaceId);
    expect(stored!.policy).toEqual({
      version: "hash-1",
      paused: false,
      acceptMode: "off",
      evalTimeoutMs: 45_000,
      sources: { chat: { allowed: [{ id: "alice", name: "Alice" }] } },
    });
    expect(stored!.rules.map((rule) => rule.id)).toEqual(["r1", "r2"]); // position order

    await savePolicy(
      db,
      r.workspaceId,
      { version: "hash-2", paused: true, acceptMode: "auto", evalTimeoutMs: 1000, sources: {} },
      [{ id: "r3", name: "Third", instruction: "do c", enabled: true, position: 1 }],
    );
    const updated = await getPolicy(db, r.workspaceId);
    expect(updated!.policy.version).toBe("hash-2");
    expect(updated!.rules.map((rule) => rule.id)).toEqual(["r3"]);
  });

  it("keeps workspaces isolated: one hydrate never reads another's rows", async () => {
    const a = await rig("tenancy-a");
    const b = await rig("tenancy-b");
    const sharedId = key();
    await a.run(() => a.store.repositories.triggers.save(trigger(sharedId, { text: "mine" })));
    await b.run(() => b.store.repositories.triggers.save(trigger(sharedId, { text: "theirs" })));

    const reopenedA = await reopen(a.workspaceId);
    const reopenedB = await reopen(b.workspaceId);
    expect(reopenedA.repositories.triggers.get(sharedId)?.text).toBe("mine");
    expect(reopenedB.repositories.triggers.get(sharedId)?.text).toBe("theirs");
    expect(reopenedA.repositories.threads.list()).toEqual([]);
    expect(reopenedB.repositories.threads.list()).toEqual([]);
  });
});
