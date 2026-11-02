/**
 * Postgres repositories for the core's synchronous `Repositories` and `Outbox`
 * ports.
 *
 * The core's commands are synchronous and every command is one transaction.
 * Postgres drivers are asynchronous, so the store cannot write through inside a
 * command. It keeps the workspace's aggregates in a cache that the commands
 * mutate, and persists with one explicit flush:
 *
 *     const store = createSuperagentStore(db, workspaceId);
 *     await store.hydrate();                                    // load the workspace once
 *     store.repositories.atomic(() => engine.receive(trigger)); // one command, cached
 *     await store.flush();                                      // one Postgres transaction
 *
 * - `atomic` snapshots the cache and rolls it back if the command throws, the
 *   same semantics `MemoryRepositories` gives the engine specs.
 * - `flush` writes every aggregate touched since its last success through
 *   compare-and-set upserts on each row's version column. A lost race — a
 *   writer outside the engine's sole-writer discipline — fails loudly instead
 *   of clobbering. A failed flush rolls the cache back to its last
 *   known-persisted state and rethrows, so a retried command starts from disk
 *   truth rather than diverged memory.
 * - Reads after `hydrate` never touch the database: the cache is the
 *   workspace's full state, so `list`, `open`, and `active` reproduce the
 *   in-memory repositories' ordering exactly (newest first for tickets,
 *   chronological for threads and decisions).
 *
 * The dispatch passes that drain effects and receipts after commit do not go
 * through this synchronous port — they use the SQL-side reads in `queries.ts`,
 * which lean on the generated columns these tables maintain.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Decision, Ticket, Trigger, TriggerDisposition, WorkThread } from "../core/model";
import { conversationKey, latestRun } from "../core/model";
import type { Outbox, OutboundMessage, ReplyStatus, Repositories } from "../core/ports";
import { assessmentColumns, latestRunState, rowToDecision, rowToThread, rowToTicket, rowToTrigger } from "./mapping";
import type { ThreadSubscriptionRow } from "./mapping";
import {
  ticketRuns,
  workAssessments,
  workDecisions,
  workSubscriptions,
  workThreads,
  workTickets,
  workTriggers,
  workEffects,
  workOutboxReceipts,
} from "./schema";
import type { EffectKind } from "./schema";

/** Raised when a flush cannot make a row match the store's known version. */
class StoreFlushError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = "StoreFlushError";
  }
}

type Entry<T> = { value: T; version: number; dirty: boolean };
/** Receipts carry no aggregate version: send-once comes from the primary key, and status moves only forward. */
type ReceiptEntry = { value: OutboundMessage; status: ReplyStatus; persisted: boolean; dirty: boolean };
/**
 * Effects carry no aggregate version either: coalescing comes from the pending (workspace, kind, key) unique index,
 * and the first enqueue of a pair wins. Effects are never hydrated — the drain pass reads the table directly —
 * so the cache only needs to survive until the flush that persists them.
 */
type EffectEntry = {
  kind: EffectKind;
  key: string;
  payload?: Record<string, unknown>;
  availableAt?: string;
  dirty: boolean;
};

type CacheSnapshot = {
  triggers: [string, Entry<Trigger>][];
  dispositions: [string, Entry<TriggerDisposition>][];
  threads: [string, Entry<WorkThread>][];
  tickets: [string, Entry<Ticket>][];
  decisions: [string, Entry<Decision>][];
  receipts: [string, ReceiptEntry][];
  hydrated: boolean;
};

type EffectRequest = {
  kind: EffectKind;
  /** The unit of work the kind names — a run id, a ticket id, a conversation key. Opaque to the queue. */
  key: string;
  payload?: Record<string, unknown>;
  /** When the effect first becomes due; omitted means immediately. */
  availableAt?: string;
};

export type SuperagentStore = {
  repositories: Repositories;
  outbox: Outbox;
  effects: {
    /**
     * Queue a durable effect — external work the engine asked for — inside the caller's command.
     * The row commits with the domain state in the same flush transaction and runs only after,
     * so a crash cannot leave work enqueued without its state, or state without its work.
     * At most one pending effect per (kind, key): the first enqueue wins, later ones coalesce into it.
     */
    enqueue(effect: EffectRequest): void;
  };
  /** Load the workspace's whole state into the cache; required before any read. */
  hydrate(): Promise<void>;
  /** Persist everything touched since the last success in one transaction. */
  flush(): Promise<void>;
};

export function createSuperagentStore(db: PostgresJsDatabase, workspaceId: string): SuperagentStore {
  const clone = <T>(value: T): T => structuredClone(value);
  const now = () => new Date();

  const triggers = new Map<string, Entry<Trigger>>();
  const dispositions = new Map<string, Entry<TriggerDisposition>>();
  const threads = new Map<string, Entry<WorkThread>>();
  const tickets = new Map<string, Entry<Ticket>>();
  const decisions = new Map<string, Entry<Decision>>();
  const receipts = new Map<string, ReceiptEntry>();
  const effects = new Map<string, EffectEntry>();

  let hydrated = false;
  /** The cache state to restore if the flush of the current command fails. */
  let pendingSnapshot: CacheSnapshot | null = null;

  function requireHydrated(): void {
    if (!hydrated) {
      throw new StoreFlushError("The superagent store was read before hydrate() — call it once per workspace first.");
    }
  }

  function snapshot(): CacheSnapshot {
    return {
      triggers: [...triggers.entries()].map(([id, entry]) => [id, { ...entry, value: clone(entry.value) }]),
      dispositions: [...dispositions.entries()].map(([id, entry]) => [id, { ...entry, value: clone(entry.value) }]),
      threads: [...threads.entries()].map(([id, entry]) => [id, { ...entry, value: clone(entry.value) }]),
      tickets: [...tickets.entries()].map(([id, entry]) => [id, { ...entry, value: clone(entry.value) }]),
      decisions: [...decisions.entries()].map(([id, entry]) => [id, { ...entry, value: clone(entry.value) }]),
      receipts: [...receipts.entries()].map(([id, entry]) => [id, { ...entry }]),
      hydrated,
    };
  }

  function restore(snap: CacheSnapshot): void {
    triggers.clear();
    for (const [id, entry] of snap.triggers) triggers.set(id, entry);
    dispositions.clear();
    for (const [id, entry] of snap.dispositions) dispositions.set(id, entry);
    threads.clear();
    for (const [id, entry] of snap.threads) threads.set(id, entry);
    tickets.clear();
    for (const [id, entry] of snap.tickets) tickets.set(id, entry);
    decisions.clear();
    for (const [id, entry] of snap.decisions) decisions.set(id, entry);
    receipts.clear();
    for (const [id, entry] of snap.receipts) receipts.set(id, entry);
    // Effects are enqueue-only and not restorable from a snapshot: a failed flush rolls the
    // command back, so its enqueues must vanish with it. A retried command enqueues again.
    effects.clear();
    hydrated = snap.hydrated;
  }

  function mark<T>(cache: Map<string, Entry<T>>, id: string, value: T): void {
    // The first dirty mark of a flush cycle snapshots the cache before it, so
    // a failed flush restores the last persisted state, not the failed save.
    if (!pendingSnapshot) pendingSnapshot = snapshot();
    const existing = cache.get(id);
    cache.set(id, { value: clone(value), version: existing?.version ?? 0, dirty: true });
  }

  const repositories: Repositories = {
    atomic<T>(work: () => T): T {
      const snap = snapshot();
      pendingSnapshot = snap;
      try {
        return work();
      } catch (error) {
        restore(snap);
        pendingSnapshot = null;
        throw error;
      }
    },
    triggers: {
      get: (id) => {
        requireHydrated();
        const entry = triggers.get(id);
        return entry ? clone(entry.value) : undefined;
      },
      save: (trigger) => mark(triggers, trigger.id, trigger),
      disposition: (id) => {
        requireHydrated();
        const entry = dispositions.get(id);
        return entry ? clone(entry.value) : undefined;
      },
      saveDisposition: (id, value) => mark(dispositions, id, value),
    },
    threads: {
      get: (key) => {
        requireHydrated();
        const entry = threads.get(key);
        return entry ? clone(entry.value) : undefined;
      },
      save: (thread) => mark(threads, thread.key, thread),
      list: () => {
        requireHydrated();
        return [...threads.values()].map((entry) => clone(entry.value));
      },
      active: () =>
        repositories.threads.list().filter((thread) => thread.pending.length > 0 || thread.evaluating !== undefined),
    },
    tickets: {
      get: (id) => {
        requireHydrated();
        const entry = tickets.get(id);
        return entry ? clone(entry.value) : undefined;
      },
      save: (ticket) => mark(tickets, ticket.id, ticket),
      /** Newest first, matching the in-memory repositories. */
      list: () => {
        requireHydrated();
        return [...tickets.values()].reverse().map((entry) => clone(entry.value));
      },
      open: () => repositories.tickets.list().filter((ticket) => !ticket.ended),
      active: () =>
        repositories.tickets
          .list()
          .filter(
            (ticket) =>
              ticket.undelivered.length > 0 || ["pending", "running"].includes(latestRun(ticket)?.state ?? ""),
          ),
    },
    decisions: {
      get: (id) => {
        requireHydrated();
        const entry = decisions.get(id);
        return entry ? clone(entry.value) : undefined;
      },
      save: (decision) => mark(decisions, decision.id, decision),
      byThread: (key) => {
        requireHydrated();
        return [...decisions.values()]
          .filter((entry) => entry.value.threadKey === key)
          .map((entry) => clone(entry.value));
      },
    },
  };

  /** Queue one durable effect inside the caller's command; shared by the effects port and the outbox's reply lane. */
  function enqueueEffect(effect: EffectRequest): void {
    // Keep the first: coalescing means one pending row per (kind, key), in the cache as on disk.
    const coalesceKey = `${effect.kind}:${effect.key}`;
    if (!effects.has(coalesceKey)) effects.set(coalesceKey, { ...effect, dirty: true });
  }

  const outbox: Outbox = {
    send: (message) => {
      if (!receipts.has(message.id)) {
        receipts.set(message.id, { value: clone(message), status: "pending", persisted: false, dirty: true });
        // Schedule the conversation's send: a coalesced reply effect whose handler drains the
        // conversation's pending receipts in seq order, retrying on the reply backoff curve
        // (5s doubling to 300s) when a send fails, and raising a health entry after three.
        const channel = message.channel;
        enqueueEffect({
          kind: "reply",
          key: conversationKey(channel),
          payload: { source: channel.source, thread: channel.thread },
        });
      }
    },
    status: (id) => receipts.get(id)?.status,
    withdraw: (id) => {
      const entry = receipts.get(id);
      if (entry && entry.status === "pending") {
        entry.status = "dropped";
        entry.dirty = true;
      }
    },
  };

  /** CAS upsert of one trigger row; a dirty disposition merges into the same write. */
  async function flushTrigger(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    id: string,
    entry: Entry<Trigger>,
  ): Promise<void> {
    const dispositionEntry = dispositions.get(id);
    const disposition = dispositionEntry?.value ?? null;
    const row = {
      workspaceId,
      id,
      source: entry.value.source,
      threads: entry.value.threads,
      actor: entry.value.actor,
      human: entry.value.human,
      addressed: entry.value.addressed ?? null,
      at: new Date(entry.value.at),
      text: entry.value.text,
      channel: entry.value.channel ?? null,
      url: entry.value.url ?? null,
      meta: entry.value.meta,
      disposition,
      version: entry.version + 1,
    };
    const written = await tx
      .insert(workTriggers)
      .values(row)
      .onConflictDoUpdate({
        target: [workTriggers.workspaceId, workTriggers.id],
        set: { ...row, version: entry.version + 1 },
        setWhere: eq(workTriggers.version, entry.version),
      })
      .returning({ id: workTriggers.id });
    if (written.length === 0) {
      throw new StoreFlushError(`Trigger ${id} changed since it was read (expected version ${entry.version}).`);
    }
    if (dispositionEntry) dispositionEntry.dirty = false;
  }

  async function flushThread(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    key: string,
    entry: Entry<WorkThread>,
  ): Promise<void> {
    const thread = entry.value;
    const row = {
      workspaceId,
      key,
      ref: thread.ref,
      createdAt: new Date(thread.createdAt),
      lastAt: thread.lastAt === undefined ? null : new Date(thread.lastAt),
      correlated: thread.correlated,
      pending: thread.pending,
      evaluating: thread.evaluating ?? null,
      expired: thread.expired ?? null,
      meta: thread.meta,
      version: entry.version + 1,
    };
    const written = await tx
      .insert(workThreads)
      .values(row)
      .onConflictDoUpdate({
        target: [workThreads.workspaceId, workThreads.key],
        set: { ...row, version: entry.version + 1 },
        setWhere: eq(workThreads.version, entry.version),
      })
      .returning({ key: workThreads.key });
    if (written.length === 0) {
      throw new StoreFlushError(`WorkThread ${key} changed since it was read (expected version ${entry.version}).`);
    }

    const projection: { workspaceId: string; threadKey: string; ticketId: string; kind: string }[] = [
      ...thread.subscriptions.map((ticketId) => ({ workspaceId, threadKey: key, ticketId, kind: "subscription" })),
      ...(thread.context ?? []).map((ticketId) => ({ workspaceId, threadKey: key, ticketId, kind: "context" })),
    ];
    await tx
      .delete(workSubscriptions)
      .where(and(eq(workSubscriptions.workspaceId, workspaceId), eq(workSubscriptions.threadKey, key)));
    if (projection.length > 0) await tx.insert(workSubscriptions).values(projection);

    // The assessment mirror is derived state, so it takes no CAS: the thread
    // document is the source of truth. Closing the thread's other open mirror
    // rows records when an eval ended — decided, replaced, or expired.
    if (thread.evaluating) {
      const mirror = { workspaceId, ...assessmentColumns(thread.evaluating), endedAt: null };
      await tx
        .insert(workAssessments)
        .values(mirror)
        .onConflictDoUpdate({
          target: [workAssessments.workspaceId, workAssessments.id],
          set: { ...mirror },
        });
    } else {
      await tx
        .update(workAssessments)
        .set({ endedAt: now() })
        .where(
          and(
            eq(workAssessments.workspaceId, workspaceId),
            eq(workAssessments.threadKey, key),
            isNull(workAssessments.endedAt),
          ),
        );
    }
  }

  async function flushTicket(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    id: string,
    entry: Entry<Ticket>,
  ): Promise<void> {
    const ticket = entry.value;
    const ended = ticket.ended;
    const row = {
      workspaceId,
      id,
      title: ticket.title,
      decisionId: ticket.decisionId,
      mandate: ticket.mandate,
      channels: ticket.channels,
      endedAt: ended === undefined ? null : new Date(ended.at),
      endedBy: ended?.by ?? null,
      endedOutcome: ended?.outcome ?? null,
      endedReason: ended?.reason ?? null,
      attention: ticket.attention ?? null,
      inputs: ticket.inputs,
      undelivered: ticket.undelivered,
      follows: ticket.follows ?? null,
      answers: ticket.answers ?? null,
      origin: ticket.origin,
      execution: ticket.execution ?? null,
      delivery: ticket.delivery ?? null,
      createdAt: new Date(ticket.createdAt),
      updatedAt: new Date(ticket.updatedAt),
      latestRunState: latestRunState(ticket),
      version: entry.version + 1,
    };
    const written = await tx
      .insert(workTickets)
      .values(row)
      .onConflictDoUpdate({
        target: [workTickets.workspaceId, workTickets.id],
        set: { ...row, version: entry.version + 1 },
        setWhere: eq(workTickets.version, entry.version),
      })
      .returning({ id: workTickets.id });
    if (written.length === 0) {
      throw new StoreFlushError(`Ticket ${id} changed since it was read (expected version ${entry.version}).`);
    }

    // Runs are the engine's append-and-machine list; replacing the ticket's
    // rows keeps the projection exactly the aggregate the engine saved.
    await tx.delete(ticketRuns).where(and(eq(ticketRuns.workspaceId, workspaceId), eq(ticketRuns.ticketId, id)));
    if (ticket.runs.length > 0) {
      await tx.insert(ticketRuns).values(
        ticket.runs.map((run) => ({
          workspaceId,
          id: run.id,
          ticketId: id,
          state: run.state,
          createdAt: new Date(run.createdAt),
          startedAt: run.startedAt === undefined ? null : new Date(run.startedAt),
          endedAt: run.endedAt === undefined ? null : new Date(run.endedAt),
          endedReason: run.endedReason ?? null,
          report: run.report ?? null,
          deliveredAt: run.deliveredAt === undefined ? null : new Date(run.deliveredAt),
          idleAt: run.idleAt === undefined ? null : new Date(run.idleAt),
        })),
      );
    }
  }

  async function flush(): Promise<void> {
    const dirtyTriggers = [...triggers.entries()].filter(([, entry]) => entry.dirty);
    const dirtyDispositions = [...dispositions.entries()].filter(([, entry]) => entry.dirty);
    const dirtyThreads = [...threads.entries()].filter(([, entry]) => entry.dirty);
    const dirtyTickets = [...tickets.entries()].filter(([, entry]) => entry.dirty);
    const dirtyDecisions = [...decisions.entries()].filter(([, entry]) => entry.dirty);
    const dirtyReceipts = [...receipts.entries()].filter(([, entry]) => entry.dirty);
    const dirtyEffects = [...effects.values()].filter((entry) => entry.dirty);
    if (
      dirtyTriggers.length === 0 &&
      dirtyDispositions.length === 0 &&
      dirtyThreads.length === 0 &&
      dirtyTickets.length === 0 &&
      dirtyDecisions.length === 0 &&
      dirtyReceipts.length === 0 &&
      dirtyEffects.length === 0
    ) {
      pendingSnapshot = null;
      return;
    }

    // A plain save outside atomic() has no pending snapshot; capture one now
    // so a failed flush still rolls the cache back to its persisted state.
    if (!pendingSnapshot) pendingSnapshot = snapshot();

    // A dirty disposition merges into its trigger's write; one that lacks a
    // cached trigger row cannot be persisted at all, so it fails loudly.
    const mergedTriggers = new Map(dirtyTriggers);
    for (const [id] of dirtyDispositions) {
      if (!mergedTriggers.has(id)) {
        const entry = triggers.get(id);
        if (!entry) {
          throw new StoreFlushError(`Disposition for trigger ${id} has no trigger row to attach to.`);
        }
        mergedTriggers.set(id, entry);
      }
    }

    try {
      await db.transaction(async (tx) => {
        for (const [id, entry] of mergedTriggers) await flushTrigger(tx, id, entry);
        // Tickets before threads: a thread flush writes its subscription
        // rows, whose foreign keys reach the tickets saved in this command.
        for (const [id, entry] of dirtyTickets) await flushTicket(tx, id, entry);
        for (const [key, entry] of dirtyThreads) await flushThread(tx, key, entry);
        for (const [id, entry] of dirtyDecisions) {
          const row = {
            workspaceId,
            id,
            assessmentId: entry.value.assessmentId,
            threadKey: entry.value.threadKey,
            triggerIds: entry.value.triggerIds,
            policyVersion: entry.value.policyVersion,
            at: new Date(entry.value.at),
            kind: entry.value.kind,
            reason: entry.value.reason,
            strength: entry.value.strength,
            ticketId: entry.value.ticketId ?? null,
            mandate: entry.value.mandate ?? null,
            audit: entry.value.audit ?? null,
            dismissed: entry.value.dismissed === true,
            version: entry.version + 1,
          };
          const written = await tx
            .insert(workDecisions)
            .values(row)
            .onConflictDoUpdate({
              target: [workDecisions.workspaceId, workDecisions.id],
              set: { ...row, version: entry.version + 1 },
              setWhere: eq(workDecisions.version, entry.version),
            })
            .returning({ id: workDecisions.id });
          if (written.length === 0) {
            throw new StoreFlushError(`Decision ${id} changed since it was read (expected version ${entry.version}).`);
          }
        }
        for (const [id, entry] of dirtyReceipts) {
          if (!entry.persisted) {
            await tx
              .insert(workOutboxReceipts)
              .values({
                workspaceId,
                id,
                channel: entry.value.channel,
                text: entry.value.text,
                kind: entry.value.kind,
                ticketId: entry.value.ticketId ?? null,
                status: entry.status,
                sentAt: entry.status === "sent" ? now() : null,
                droppedAt: entry.status === "dropped" ? now() : null,
              })
              // Send-once: an id queued before keeps its first message.
              .onConflictDoNothing({ target: [workOutboxReceipts.workspaceId, workOutboxReceipts.id] });
            entry.persisted = true;
          } else if (entry.status === "dropped") {
            // Status only moves forward; a sender process may have resolved the
            // row already, and that write wins.
            await tx
              .update(workOutboxReceipts)
              .set({ status: "dropped", droppedAt: now(), updatedAt: now() })
              .where(
                and(
                  eq(workOutboxReceipts.workspaceId, workspaceId),
                  eq(workOutboxReceipts.id, id),
                  eq(workOutboxReceipts.status, "pending"),
                ),
              );
          }
        }
        for (const entry of dirtyEffects) {
          await tx
            .insert(workEffects)
            .values({
              workspaceId,
              kind: entry.kind,
              key: entry.key,
              payload: entry.payload ?? null,
              ...(entry.availableAt === undefined ? {} : { availableAt: new Date(entry.availableAt) }),
            })
            // Coalescing: the partial unique index allows one pending row per (kind, key),
            // so the first enqueue of the pair lands and later ones no-op.
            .onConflictDoNothing({
              target: [workEffects.workspaceId, workEffects.kind, workEffects.key],
              where: sql`status = 'pending'`,
            });
          entry.dirty = false;
        }
      });
    } catch (error) {
      if (pendingSnapshot) restore(pendingSnapshot);
      pendingSnapshot = null;
      throw error instanceof StoreFlushError
        ? error
        : new StoreFlushError("The superagent store flush failed.", { cause: error });
    }

    // Each CAS writer left its row one version ahead of what the cache read;
    // advance exactly the entries just persisted, so the next save of the same
    // aggregate targets the version now on disk.
    for (const [, entry] of mergedTriggers) {
      entry.version += 1;
      entry.dirty = false;
    }
    for (const [, entry] of dirtyTickets) {
      entry.version += 1;
      entry.dirty = false;
    }
    for (const [, entry] of dirtyThreads) {
      entry.version += 1;
      entry.dirty = false;
    }
    for (const [, entry] of dirtyDecisions) {
      entry.version += 1;
      entry.dirty = false;
    }
    for (const [, entry] of dirtyDispositions) entry.dirty = false;
    for (const [, entry] of dirtyReceipts) entry.dirty = false;
    // Effects are forget-once-persisted: from here the queue's partial unique
    // index owns coalescing against pending rows on disk, and a later enqueue
    // of the same (kind, key) must reach the database again (a drained row does
    // not block the next one). Keeping the cache entry would swallow that
    // enqueue for the life of the process.
    for (const entry of dirtyEffects) effects.delete(`${entry.kind}:${entry.key}`);
    pendingSnapshot = null;
  }

  async function hydrate(): Promise<void> {
    const [triggerRows, threadRows, ticketRows, decisionRows, receiptRows, subscriptionRows, runRows] =
      await Promise.all([
        db
          .select()
          .from(workTriggers)
          .where(eq(workTriggers.workspaceId, workspaceId))
          .orderBy(workTriggers.at, workTriggers.id),
        db
          .select()
          .from(workThreads)
          .where(eq(workThreads.workspaceId, workspaceId))
          .orderBy(workThreads.createdAt, workThreads.key),
        db.select().from(workTickets).where(eq(workTickets.workspaceId, workspaceId)).orderBy(workTickets.seq),
        db.select().from(workDecisions).where(eq(workDecisions.workspaceId, workspaceId)).orderBy(workDecisions.seq),
        db
          .select()
          .from(workOutboxReceipts)
          .where(eq(workOutboxReceipts.workspaceId, workspaceId))
          .orderBy(workOutboxReceipts.seq),
        db.select().from(workSubscriptions).where(eq(workSubscriptions.workspaceId, workspaceId)),
        db.select().from(ticketRuns).where(eq(ticketRuns.workspaceId, workspaceId)).orderBy(ticketRuns.seq),
      ]);

    const runsByTicket = new Map<string, typeof runRows>();
    for (const row of runRows) {
      const list = runsByTicket.get(row.ticketId) ?? [];
      list.push(row);
      runsByTicket.set(row.ticketId, list);
    }
    const subsByThread = new Map<string, ThreadSubscriptionRow[]>();
    for (const row of subscriptionRows) {
      const list = subsByThread.get(row.threadKey) ?? [];
      list.push({ ticketId: row.ticketId, kind: row.kind });
      subsByThread.set(row.threadKey, list);
    }

    triggers.clear();
    dispositions.clear();
    for (const row of triggerRows) {
      triggers.set(row.id, { value: rowToTrigger(row), version: row.version, dirty: false });
      if (row.disposition) dispositions.set(row.id, { value: row.disposition, version: row.version, dirty: false });
    }
    threads.clear();
    for (const row of threadRows) {
      threads.set(row.key, {
        value: rowToThread(row, subsByThread.get(row.key) ?? []),
        version: row.version,
        dirty: false,
      });
    }
    tickets.clear();
    for (const row of ticketRows) {
      tickets.set(row.id, {
        value: rowToTicket(row, runsByTicket.get(row.id) ?? []),
        version: row.version,
        dirty: false,
      });
    }
    decisions.clear();
    for (const row of decisionRows) {
      decisions.set(row.id, { value: rowToDecision(row), version: row.version, dirty: false });
    }
    receipts.clear();
    for (const row of receiptRows) {
      receipts.set(row.id, {
        value: {
          id: row.id,
          channel: row.channel,
          text: row.text,
          kind: row.kind as OutboundMessage["kind"],
          ticketId: row.ticketId ?? undefined,
        },
        status: row.status as ReplyStatus,
        persisted: true,
        dirty: false,
      });
    }
    hydrated = true;
    pendingSnapshot = null;
  }

  return {
    repositories,
    outbox,
    effects: {
      enqueue: enqueueEffect,
    },
    hydrate,
    flush,
  };
}
