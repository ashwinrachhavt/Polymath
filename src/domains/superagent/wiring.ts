/*
 * The cutover wiring: how the superagent domain is composed inside Polymath.
 *
 * One place owns the composition so every caller — the chat send path, the
 * supervision panel, the internal drain routes — sees the same Engine over
 * the same real repositories. Per the spec (§4): the core is pure, the store
 * persists it, the assessor and executor run on eve behind their seams, and
 * this module is the only file that puts all of them together.
 *
 * Composition per workspace (cached per process):
 *
 *   superagentForWorkspace(ws)
 *     ├─ createSuperagentStore(db, ws)            durable repositories + outbox
 *     ├─ storedPolicyConfig → createPolicy        the gate, version-hashed
 *     ├─ SourceRegistry(chatSourceKind)           the one v1 Source
 *     ├─ createSuperagentAssessor(host)           the eval seam over eve
 *     ├─ createSuperagentExecutor(host)           the ticket executor over eve
 *     └─ createEngine({ repo, policy, … })        the sole writer
 *
 * The chat Source's per-conversation read positions and the observer's
 * reported-run cursors are host bookkeeping, not domain state: they live in
 * `superagent_state` (migration 0276) and never enter the policy version
 * hash — a cursor bump must not discard running assessments.
 */
import postgres from "postgres";
import { and, asc, desc, eq, isNull, like, sql } from "drizzle-orm";

import { createConversationRun } from "@/domains/agents/conversations";
import { createEngine as createAgentsEngine } from "@/domains/agents/engine";
import type { AgentEngine } from "@/domains/agents/engine";
import { recordRoundEvent } from "@/domains/agents/event-bridge";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { createEveDriver, eveAgentForProfile } from "@/domains/agents/eve-driver";
import { workspaceOwnerAuth } from "@/domains/audit/outbox-handlers";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";

import {
  createSuperagentAssessor,
  parseAssessorConfig,
  type AssessmentPayload,
  type EngineForAssessor,
  type SuperagentAssessor,
} from "./assessor";
import { createEvalSeam } from "./assessor/eve";
import { runningTicketRun } from "./core";
import { createEngine, type Engine, type EngineForExecutor, type WorkerReport } from "./core/engine";
import type { AcceptMode, OutboundMessage, ReceiveResult, Trigger } from "./core";
import type { PolicyConfig } from "./core/policy/gate";
import { createPolicy, type SourcePolicy } from "./core/policy/gate";
import { decideClientFromEnv } from "./decide";
import { runEffectsPass } from "./effects";
import { type ClaimedReceipt, type ReceiptSender } from "./effects/receipts";
import { effectHandlers } from "./effects/handlers";
import { type EffectHandler, type EffectHandlers, type RawClient } from "./effects/queue";
import { createSuperagentExecutor, parseExecutorConfig, type LaunchPayload, type SuperagentExecutor } from "./executor";
import { createEveSeam } from "./executor/eve";
import { CHAT_SOURCE_KIND, chatSourceKind, chatTrigger, type ChatSourceConfig } from "./sources/chat";
import type { ChatEvent, SourceContext, SourceState } from "./sources/host";
import { SourceRegistry } from "./sources/registry";
import { createSuperagentStore, getPolicy, readStateValue, storedPolicyConfig, writeStateValue } from "./store";
import { superagentState, workThreads, workTickets } from "./store/schema";
import type { SuperagentStore } from "./store/repositories";

/** The executor's delivery-effect payload: which ticket run the input wakes. */
type DeliveryPayload = { ticketId: string; runId: string };

/** How many dispatch passes one inline drain may chain (assessment → decide → launch → reply). */
const MAX_INLINE_PASSES = 4;

/**
 * The v1 chat part of the Policy, supplied by the wiring when the workspace
 * has not stored one. Every chat message is a person directly addressing the
 * agent, so the receiving scope's unlisted-addressed cell grants `explicit`:
 * explicit requests always work, and nothing proactive is enabled (accept
 * mode ships off, the rules list starts empty). The store's mapper cannot
 * express an explicit cell yet (a wave-two settings editor gets the gate's
 * own vocabulary), so the posture lives here at composition time — read-side
 * only, never persisted, and identical on every host so the version hash of
 * a mandate accepted under it stays reproducible.
 */
const CHAT_POLICY_DEFAULT: SourcePolicy = {
  allowed: [],
  bots: [],
  admission: { chat: { unlistedAddressed: "explicit" } },
};

/** The chat Source's own config, projected from the stored part's `listen` field. */
function chatConfigOf(storedSources: Record<string, Record<string, unknown>>): ChatSourceConfig {
  return { listen: storedSources[CHAT_SOURCE_KIND]?.listen === "all" ? "all" : "mentions" };
}

export type SuperagentHost = {
  workspaceId: string;
  store: SuperagentStore;
  registry: SourceRegistry;
  config: PolicyConfig;
  /** The stored policy document's version hash this composition was built from ("" when none was stored). */
  policyVersion: string;
  /** The stored policy document's per-Source config parts (the `listen` field lives here). */
  storedSources: Record<string, Record<string, unknown>>;
  engine: Engine;
  assessor: SuperagentAssessor;
  executor: SuperagentExecutor;
  /** The chat Source's context: translation, receive, read positions, the reply sink. */
  chat: SourceContext;
  /**
   * Persist domain writes and the wiring's own state rows, then run the
   * host's post-commit work (stale-session cancels). Every command path
   * ends with `await host.flush()` after its atomic.
   */
  flush(): Promise<void>;
  /** Load the workspace into the store's cache. Safe to call again; it re-reads. */
  hydrate(): Promise<void>;
};

/* ------------------------------------------------------------------ */
/* The workspace host                                                  */
/* ------------------------------------------------------------------ */

const hosts = new Map<string, Promise<SuperagentHost>>();

/** Build (or return the cached) composition for one workspace. */
export function superagentForWorkspace(workspaceId: string): Promise<SuperagentHost> {
  const cached = hosts.get(workspaceId);
  if (cached) return cached;
  const built = buildHost(workspaceId);
  hosts.set(workspaceId, built);
  // A failed build must not poison the cache: the next caller retries.
  built.catch(() => hosts.delete(workspaceId));
  return built;
}

/** Drop one workspace's cached composition; the next caller rebuilds it (a policy save does). */
export function evictSuperagentHost(workspaceId: string): void {
  hosts.delete(workspaceId);
}

/**
 * Evict a composition built from an older policy document. A policy save
 * evicts the saving process's cache; a separate worker process learns about
 * the change here, by comparing the stored version against the stamp the
 * composition was built from, once per sweep pass.
 */
export async function evictStaleSuperagentHost(workspaceId: string): Promise<void> {
  const cached = await hosts.get(workspaceId);
  if (!cached) return;
  const stored = await getPolicy(db, workspaceId);
  if (cached.policyVersion !== (stored?.policy.version ?? "")) evictSuperagentHost(workspaceId);
}

async function buildHost(workspaceId: string): Promise<SuperagentHost> {
  const store = createSuperagentStore(db, workspaceId);

  /* The one v1 Source, over the policy's stored parts (defaults when absent). */
  const stored = await getPolicy(db, workspaceId);
  const base = storedPolicyConfig(stored);
  const config: PolicyConfig = {
    ...base,
    // The v1 chat posture (see CHAT_POLICY_DEFAULT): an unlisted sender's
    // direct message is an explicit request. A stored chat part wins.
    sources: { [CHAT_SOURCE_KIND]: CHAT_POLICY_DEFAULT, ...base.sources },
  };
  const registry = new SourceRegistry((kind) =>
    kind === CHAT_SOURCE_KIND
      ? chatConfigOf((stored?.policy.sources ?? {}) as Record<string, Record<string, unknown>>)
      : undefined,
  );
  registry.register(chatSourceKind);
  const policy = createPolicy(config, registry.scope());

  /* The eve seams: one agents engine per surface, as the routes build them.
   * Each seam resolves its own mount from the profile it actually starts: the
   * assessor's eval sessions run on the specialist agent (the profile's
   * charter rides the specialist brief), while the executor's ticket runs
   * keep the polymath agent and its full toolset. Wiring both seams to one
   * hardcoded mount ran the eval session with the chief-of-staff toolset —
   * which has no orchestrator_eval* tools — so every assessment expired
   * unread (found by the wave-1 end-to-end verification). */
  const assessorConfig = parseAssessorConfig();
  const executorConfig = parseExecutorConfig();
  const evalEngine: AgentEngine = createAgentsEngine(createEveDriver(eveAgentForProfile(assessorConfig.profileName)));
  const ticketEngine: AgentEngine = createAgentsEngine(createEveDriver(eveAgentForProfile(executorConfig.profileName)));

  const afterCommitQueue: (() => Promise<void>)[] = [];
  const afterCommit = (work: () => Promise<void>): void => {
    afterCommitQueue.push(work);
  };

  /*
   * The port hosts take the Engine directly (the prototype's sole-writer
   * rule: the parts hold their writer). The Engine needs the hosts first —
   * so the hosts are built with the field unassigned and the slices are
   * filled the moment the Engine exists, before any port can run: a handler
   * only reaches `engine` when a claimed effect calls it, and effects only
   * exist after a command flushed.
   */
  const assessorHost = {
    workspaceId,
    repos: store.repositories,
    engine: undefined as unknown as EngineForAssessor,
    effects: { enqueue: store.effects.enqueue },
    eve: createEvalSeam(evalEngine),
    decide: decideClientFromEnv(process.env),
    afterCommit,
    flush: () => flushHost(),
    afterDecision: () => drainSuperagentInline(workspaceId).then(() => undefined),
    auth: () => backgroundAuth(workspaceId),
    policyView: () => ({ rules: config.rules, mode: config.mode }),
    config: assessorConfig,
  };
  const assessor: SuperagentAssessor = createSuperagentAssessor(assessorHost);

  const executorHost = {
    workspaceId,
    repos: store.repositories,
    engine: undefined as unknown as EngineForExecutor,
    effects: { enqueue: store.effects.enqueue },
    eve: createEveSeam(ticketEngine),
    afterCommit,
    flush: () => flushHost(),
    auth: () => backgroundAuth(workspaceId),
    config: executorConfig,
    acceptMode: (): AcceptMode => config.mode,
  };
  const executor: SuperagentExecutor = createSuperagentExecutor(executorHost);

  // Assigned below, before any port can run; the host closes over it.
  const engine = createEngine({
    repo: store.repositories,
    policy: () => policy,
    scope: registry.scope(),
    assessor,
    executor,
    outbox: store.outbox,
  });
  assessorHost.engine = engine;
  executorHost.engine = engine;

  const flushHost = async (): Promise<void> => {
    await store.flush();
    const pending = afterCommitQueue.splice(0, afterCommitQueue.length);
    for (const work of pending) await work();
  };

  const host: SuperagentHost = {
    workspaceId,
    store,
    registry,
    config,
    policyVersion: stored?.policy.version ?? "",
    storedSources: (stored?.policy.sources ?? {}) as Record<string, Record<string, unknown>>,
    engine,
    assessor,
    executor,
    chat: undefined as unknown as SourceContext,
    flush: flushHost,
    hydrate: () => store.hydrate(),
  };
  // The context closes over the finished host (receive runs the engine).
  host.chat = chatSourceContext(host);
  return host;
}

/** Background actor: the workspace's earliest active owner, as every other outbox handler resolves one. */
async function backgroundAuth(workspaceId: string): Promise<AuthContext> {
  const auth = await workspaceOwnerAuth(workspaceId);
  if (!auth) throw new Error(`Workspace ${workspaceId} has no active owner to act for superagent work.`);
  return auth;
}

/* ------------------------------------------------------------------ */
/* The chat Source's context                                           */
/* ------------------------------------------------------------------ */

/** The read position of one conversation, keyed per run — a workspace's conversations advance independently. */
const readCursorKey = (runId: string): string => `chat:read-cursor:${runId}`;

/**
 * The chat Source's host seams, over Polymath's durable transcript (`run_events`)
 * and the wiring's state rows. The v1 intake drives it from the send path; a
 * background poller over every conversation run is the wave-two shape and
 * needs nothing this context does not already provide.
 */
function chatSourceContext(host: SuperagentHost): SourceContext {
  const workspaceId = host.workspaceId;
  /** The Source's read positions, cached in memory and persisted through superagent_state. */
  const positions = new Map<string, string>();
  const state: SourceState = {
    get: (key) => positions.get(key),
    // Fire-and-forget persistence: the state is bookkeeping, and the send
    // path's own cursor write (awaited) is the durable one.
    set: (key, value) => {
      if (value === undefined) positions.delete(key);
      else positions.set(key, value);
      void writeStateValue(db, workspaceId, key, value ?? "").catch((error) =>
        console.error(`[superagent] failed to persist source state ${key}:`, error),
      );
    },
  };
  return {
    config: (kind) => (kind === CHAT_SOURCE_KIND ? chatConfigOf(host.storedSources) : undefined),
    receive: (trigger: Trigger): ReceiveResult => host.engine.receive(trigger),
    state,
    events: {
      // The v1 intake drives translation directly from the send path (the
      // one place a new conversation event exists), and Polymath's store is
      // asynchronous while the Source contract's reader is synchronous — a
      // background poller is the wave-two shape, and these throw rather
      // than pretend to have read nothing.
      latestSequence(): number | undefined {
        throw new Error("The chat Source has no background poller in v1; translation runs in the send path.");
      },
      after(_sequence: number): ChatEvent[] {
        throw new Error("The chat Source has no background poller in v1; translation runs in the send path.");
      },
    },
    chatStream: {
      send: (message) => sendChatReply(workspaceId, message),
    },
  };
}

/** A conversation run: sessionless by construction — created by the send path, never by a driver. */
const conversationRunFilter = and(isNull(agentRuns.sessionRef), eq(agentRuns.state, "waiting_input"));

/**
 * The chat transcript reader: the message-shaped events of the workspace's
 * conversation runs, oldest first. Ticket runs are excluded structurally —
 * their sessions exist (session_ref is set) and their seeded objective is
 * machinery the chat Source drops anyway.
 */
async function readConversationEvents(
  workspaceId: string,
  input: { after?: number; runId?: string },
): Promise<ChatEvent[]> {
  const rows = await db
    .select({
      runId: runEvents.runId,
      sequence: runEvents.sequence,
      type: runEvents.type,
      data: runEvents.data,
      actorId: agentRuns.createdBy,
      threadId: agentRuns.threadId,
      at: runEvents.createdAt,
    })
    .from(runEvents)
    .innerJoin(agentRuns, and(eq(agentRuns.id, runEvents.runId), eq(agentRuns.workspaceId, workspaceId)))
    .where(
      and(
        conversationRunFilter,
        ...(input.runId ? [eq(runEvents.runId, input.runId)] : []),
        ...(input.after !== undefined ? [sql`${runEvents.sequence} > ${input.after}`] : []),
      ),
    )
    .orderBy(asc(runEvents.sequence));
  return rows.map((row) => ({
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    data: (row.data ?? {}) as Record<string, unknown>,
    actorId: row.actorId ?? "",
    ...(row.threadId ? { threadId: row.threadId } : {}),
    at: row.at.toISOString(),
  }));
}

/**
 * Where a superagent reply goes: into the addressed conversation run's own
 * transcript, as a finished assistant block the existing stream already
 * carries. The run is sessionless — nothing answers it — so the outbox's
 * frame is the only writer under this address, and a retry re-renders in
 * place (the block id keys on the message id). Returns `'gone'` when the
 * conversation can never receive it: the run row is missing (a workspace
 * purge cascaded it) and no retry changes that.
 */
async function sendChatReply(workspaceId: string, message: OutboundMessage): Promise<"sent" | "gone"> {
  const runId = message.channel.address.runId;
  if (typeof runId !== "string" || runId.length === 0)
    throw new Error("Missing chat reply target: no run in the channel address");
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!run) return "gone";
  await recordRoundEvent({
    runId,
    workspaceId,
    type: "message.completed",
    data: { turnId: `superagent:${message.id}`, stepIndex: 0, message: message.text, finishReason: null },
  });
  return "sent";
}

/** The receipt lane's sender: the same sink, over a claimed receipt row. */
const chatReceiptSender: ReceiptSender = async (receipt: ClaimedReceipt) => {
  const message: OutboundMessage = {
    id: receipt.id,
    channel: receipt.channel,
    text: receipt.text,
    kind: "reply",
    ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}),
  };
  return sendChatReply(receipt.workspaceId, message);
};

/* ------------------------------------------------------------------ */
/* The chat intake entry (the send path)                               */
/* ------------------------------------------------------------------ */

/**
 * The chat send path's superagent entry, all the way from the person's
 * words: the sessionless conversation run (the durable transcript), the
 * chat Source's translation of its first message event, the Engine's
 * receive, and the inline drain. Returns the run the surface streams.
 *
 * The conversation run is deliberately sessionless — under the reactive
 * path the run WAS the work (engine.start reserved spend and opened the
 * eve session in one call); under the pipeline the run is only the
 * transcript the Source reads, and the actual work happens in the ticket's
 * own run, which reserves its own spend. The entry throws only when the
 * conversation row itself cannot exist (no profile, no bridge): a send must
 * not fail because the pipeline refused a candidate or the drain hit its
 * pass cap — those are recorded domain outcomes, not errors.
 */
export async function startSuperagentConversation(input: {
  auth: AuthContext;
  profileName: string;
  message: string;
  subjects?: { type: "project" | "document" | "artifact"; id: string }[];
}): Promise<{ runId: string; received: ReceiveResult }> {
  // The transcript carrier: a waiting_input run with no session, whose first
  // event is the person's own words. Created before intake so the Source's
  // stable id (key("chat", runId, sequence)) exists to hang the Trigger on.
  const { runId } = await createConversationRun(input);

  const host = await superagentForWorkspace(input.auth.workspaceId);
  await host.hydrate();

  // The chat Source's translation over the event just written: same plugin,
  // same stable id, same drop rules (an agent's own message produces none).
  const events = await readConversationEvents(input.auth.workspaceId, { runId });
  const trigger = chatTrigger(events[events.length - 1]!);
  if (!trigger) throw new Error("The conversation's first message did not translate into a trigger.");

  const result = host.engine.receive(trigger);
  // The read position advances only after the trigger was stored, so a crash
  // before it replays as a duplicate rather than a lost message (the plugin's
  // own rule; the send path enforces it because it bypasses pollChat).
  await writeStateValue(db, input.auth.workspaceId, readCursorKey(runId), String(events[events.length - 1]!.sequence));
  await host.flush();
  await drainSuperagentInline(input.auth.workspaceId);
  return { runId, received: result };
}

/* ------------------------------------------------------------------ */
/* The drain                                                           */
/* ------------------------------------------------------------------ */

export type DrainSummary = { passes: number; claimed: number; completed: number; failed: number; deferred: number };

/** Null result for a workspace with nothing to do; the panel renders zero counts honestly. */
export const emptyDrain = (): DrainSummary => ({ passes: 0, claimed: 0, completed: 0, failed: 0, deferred: 0 });

/** The module's one raw client for the queue's claim/complete/fail mechanics (single connection, as the routes use). */
let rawClient: RawClient | undefined;
function queueClient(): RawClient {
  rawClient ??= postgres(process.env.DATABASE_URL ?? "", { max: 1 });
  return rawClient;
}

/**
 * The engine's tick, serverless edition. The prototype ticked every two
 * seconds in-process: start the Evals of WorkThreads whose queued Triggers
 * wait (which is also what fires the assessor's request, enqueueing the
 * assessment effect), expire overdue Evals, and release ended tickets a
 * person's message reached. Vercel has no scheduler, so every drain and
 * every dispatch pass ticks the workspaces that hold active work first.
 */
async function tickWorkspace(workspaceId: string): Promise<void> {
  const host = await superagentForWorkspace(workspaceId);
  // The sweep reaches this cold — a cron pass or the worker's loop has no
  // warm host — and the engine's reads require hydration, so the tick that
  // starts due evals would throw before observing anything.
  await host.hydrate();
  host.engine.evaluateDue();
  await host.flush();
}

/**
 * Drain one workspace's effects inline, right after the command that enqueued
 * them: tick first (start the evals that produce effects), then bounded
 * passes, each observed, so a reply lands in the same request when the
 * pipeline is warm and never blocks the send when it is not.
 */
export async function drainSuperagentInline(workspaceId: string): Promise<DrainSummary> {
  const summary = emptyDrain();
  await tickWorkspace(workspaceId);
  for (let pass = 0; pass < MAX_INLINE_PASSES; pass += 1) {
    summary.passes += 1;
    const drained = await runEffectsPass(queueClient(), await superagentEffectHandlers(), {
      workerId: `inline:${workspaceId}`,
      workspaceId,
    });
    summary.claimed += drained.claimed;
    summary.completed += drained.done;
    summary.failed += drained.failed;
    summary.deferred += drained.deferred;
    await observeWorkspace(workspaceId);
    if (drained.claimed === 0) break;
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* The effects handler registry, from the wiring's side                */
/* ------------------------------------------------------------------ */

/** Route one claimed effect to its workspace's host and handler. */
async function dispatchEffect(
  effect: { workspaceId: string },
  run: (host: SuperagentHost) => Promise<void>,
): Promise<void> {
  const host = await superagentForWorkspace(effect.workspaceId);
  await run(host);
}

/**
 * The handler map the drain routes use: the effects module's base consumers
 * (the reply lane's sender — the chat Source's sink) plus the wiring's own
 * consumers for the executor's and assessor's kinds. Built lazily so no host
 * exists until an effect needs one; kinds without a consumer park without
 * failure (the queue's rule).
 */
export async function superagentEffectHandlers(): Promise<EffectHandlers> {
  const handlers: Record<string, EffectHandler> = {
    ...effectHandlers({ rawClient: queueClient(), sender: chatReceiptSender }),
    assessment: (effect) =>
      dispatchEffect(effect, (host) => host.assessor.handleAssessment(effect.payload as unknown as AssessmentPayload)),
    // The expiry reap: the tick that observes an eval's deadline. evaluateDue
    // expires what is past due (requeue twice, then unavailable) and starts
    // whatever else is due; follow-up effects it enqueues are claimed by the
    // drain's next pass.
    reap: (effect) =>
      dispatchEffect(effect, async (host) => {
        host.engine.evaluateDue();
        await host.flush();
      }),
    launch: (effect) =>
      dispatchEffect(effect, (host) => host.executor.handleLaunch(effect.payload as unknown as LaunchPayload)),
    delivery: (effect) =>
      dispatchEffect(effect, (host) => host.executor.handleDelivery(effect.payload as unknown as DeliveryPayload)),
  };
  return handlers as EffectHandlers;
}

/* ------------------------------------------------------------------ */
/* The ticket-run observer                                             */
/* ------------------------------------------------------------------ */

/**
 * Watch the workspace's live ticket runs against their agent runs. Two
 * observations, both reported exactly once (the observer's cursor in
 * superagent_state guards each):
 *
 * - A run row that reached a terminal state without the domain learning it
 *   (a session that closed outright). The bridge's terminal vocabulary is
 *   succeeded | failed | cancelled (event-bridge.ts).
 * - A completed turn on a run whose row stays open — polymath runs are
 *   create-once sessions that persist across turns, so the row alone never
 *   signals "work happened". Each turn.completed is reported once, with the
 *   turn's newest assistant answer as the ready summary.
 */
async function observeWorkspace(workspaceId: string): Promise<void> {
  const host = await superagentForWorkspace(workspaceId);
  await host.hydrate();
  const live = host.store.repositories.tickets
    .active()
    .map((ticket) => ({ ticket, run: runningTicketRun(ticket) }))
    .filter(
      (entry): entry is { ticket: (typeof entry)["ticket"]; run: NonNullable<(typeof entry)["run"]> } =>
        entry.run !== undefined,
    );
  if (live.length === 0) return;

  // The ticket run → agent run link is the executor's own subjects marker
  // (executor/eve.ts's byRunSubject), not a column: query it the same way.
  const agentRunById = new Map<string, { id: string; state: string }>();
  for (const { run } of live) {
    const rows = await db
      .select({ id: agentRuns.id, state: agentRuns.state })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspaceId, workspaceId),
          sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "superagent_ticket_run", id: run.id }])}::jsonb`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (rows[0]) agentRunById.set(run.id, rows[0]);
  }
  const observedRows = await db
    .select({ key: superagentState.key })
    .from(superagentState)
    .where(and(eq(superagentState.workspaceId, workspaceId), like(superagentState.key, "superagent:observed:%")));
  const alreadyObserved = new Set(observedRows.map((row) => row.key));
  let changed = false;
  for (const { ticket, run } of live) {
    const agentRun = agentRunById.get(run.id);
    if (!agentRun) continue;
    const report = reportFor(agentRun.state, agentRun.id);
    if (report) {
      if (alreadyObserved.has(observerKey(agentRun.id))) continue;
      try {
        host.engine.turnEnded(ticket.id, run.id);
        host.engine.report(ticket.id, report);
        // A closed run's result tells the outcome in the channel the ticket
        // started in (the ready/completed rule), same as a turn's answer.
        if (report.state === "ready") {
          host.engine.reply({ purpose: "result", ticketId: ticket.id, text: report.summary });
        }
      } catch (error) {
        // An ended ticket or an already-ended run means the domain moved on
        // first; record the observation and let the next state win.
        console.error(`[superagent] observer report failed for ticket ${ticket.id}:`, error);
      }
      await writeStateValue(db, workspaceId, observerKey(agentRun.id), agentRun.state);
      changed = true;
      continue;
    }
    const turn = await lastCompletedTurn(agentRun.id);
    if (!turn || alreadyObserved.has(observerKey(agentRun.id, turn.eventId))) continue;
    const turnReport: WorkerReport = turn.summary
      ? { state: "ready", summary: turn.summary }
      : { state: "waiting", summary: "The run's turn ended without an answer." };
    try {
      host.engine.turnEnded(ticket.id, run.id);
      host.engine.report(ticket.id, turnReport);
      // The turn's answer is the ticket's result: queue it back to the
      // channel the ticket started in. The result rule allows it once the
      // report settled the ticket (or its latest report is ready), and the
      // reply's deterministic id keeps a replay from sending it twice.
      if (turnReport.state === "ready" && turn.summary) {
        host.engine.reply({ purpose: "result", ticketId: ticket.id, text: turn.summary });
      }
    } catch (error) {
      console.error(`[superagent] observer report failed for ticket ${ticket.id}:`, error);
    }
    await writeStateValue(db, workspaceId, observerKey(agentRun.id, turn.eventId), "turn.completed");
    changed = true;
  }
  if (changed) await host.flush();
}

/** The observer's state key for one agent run: reported exactly once. */
const observerKey = (agentRunId: string, turnEventId?: string): string =>
  turnEventId === undefined
    ? `superagent:observed:${agentRunId}`
    : `superagent:observed:${agentRunId}:turn:${turnEventId}`;

/**
 * The run's newest completed turn and its newest assistant answer, or
 * undefined while the run's newest event is not a turn end — mid-turn
 * events (usage, streaming) must not report.
 */
async function lastCompletedTurn(agentRunId: string): Promise<{ eventId: string; summary?: string } | undefined> {
  const events = await db
    .select({ id: runEvents.id, type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(eq(runEvents.runId, agentRunId))
    .orderBy(desc(runEvents.sequence))
    .limit(6);
  const newest = events[0];
  if (!newest || newest.type !== "turn.completed") return undefined;
  const answer = events.find(
    (event) =>
      event.type === "message" &&
      (event.data as { role?: string } | null)?.role === "assistant" &&
      typeof (event.data as { content?: string } | null)?.content === "string",
  );
  const text = ((answer?.data as { content?: string } | null)?.content ?? "").trim();
  return { eventId: newest.id, ...(text ? { summary: text.slice(0, 400) } : {}) };
}

/** Map an agent run's terminal state to the worker report the domain records. */
function reportFor(state: string, agentRunId: string): WorkerReport | undefined {
  if (state === "succeeded") return { state: "ready", summary: `Run ${agentRunId} finished.` };
  if (state === "failed") return { state: "failed", summary: `Run ${agentRunId} failed.` };
  if (state === "cancelled") return { state: "failed", summary: `Run ${agentRunId} was cancelled.` };
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The cron/recovery sweep                                             */
/* ------------------------------------------------------------------ */

/**
 * Observe every workspace with open tickets — the cron recovery pass's
 * superagent step. Cheap when the table is small (the common case); a busy
 * deployment drains through the dispatch route, which observes per workspace
 * anyway.
 */
export async function sweepSuperagentWorkspaces(): Promise<void> {
  // Workspaces holding active work: a thread with queued triggers or a live
  // eval (the generated is_active column), or an open ticket that can hold a
  // live ticket run. Each gets the tick (start due evals) and the observer
  // (report agent runs that ended without the domain learning it).
  const [threads, tickets] = await Promise.all([
    db.selectDistinct({ workspaceId: workThreads.workspaceId }).from(workThreads).where(eq(workThreads.isActive, true)),
    db.selectDistinct({ workspaceId: workTickets.workspaceId }).from(workTickets).where(isNull(workTickets.endedAt)),
  ]);
  const workspaceIds = [...new Set([...threads, ...tickets].map((row) => row.workspaceId))];
  for (const workspaceId of workspaceIds) {
    try {
      await evictStaleSuperagentHost(workspaceId);
      await tickWorkspace(workspaceId);
      await observeWorkspace(workspaceId);
    } catch (error) {
      console.error(`[superagent] observer sweep failed for workspace ${workspaceId}:`, error);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Wiring state (migration 0276): cursors, observer cursors            */
/* ------------------------------------------------------------------ */

/** Read the wiring's stored value for one key. */
export async function getWiringState(workspaceId: string, key: string): Promise<string | undefined> {
  return readStateValue(db, workspaceId, key);
}

/** Persist the wiring's stored value for one key (host bookkeeping, never domain state). */
export async function setWiringState(workspaceId: string, key: string, value: string): Promise<void> {
  await writeStateValue(db, workspaceId, key, value);
}
