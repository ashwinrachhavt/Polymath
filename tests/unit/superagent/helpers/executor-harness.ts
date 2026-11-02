/**
 * The executor specs' harness: real core engine over in-memory repositories
 * with the real executor as its Executor port, a fake eve seam and effects
 * queue around them. Shared by the executor and wiring spec suites.
 */
import { vi } from "vitest";
import type { AuthContext } from "@/domains/identity/resolve";
import {
  Engine,
  MemoryRepositories,
  type Candidate,
  type EngineOptions,
  type OutboundMessage,
  type Policy,
  type Ticket,
  type TicketInput,
  type TicketRun,
  type Trigger,
} from "@/domains/superagent/core";
import {
  EXECUTOR_DEFAULTS,
  createSuperagentExecutor,
  type ExecutorConfig,
  type ExecutorHost,
  type LaunchPayload,
} from "@/domains/superagent/executor";
import { isActiveRunState, type EveForSuperagent, type LiveRun } from "@/domains/superagent/executor/eve";

const WORKSPACE = "ws-1";
const auth: AuthContext = { userId: "owner-1", workspaceId: WORKSPACE, role: "owner" };

export function trig(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: "chat",
    threads: [{ source: "chat", id: "t1" }],
    actor: { source: "chat", id: "alice" },
    human: true,
    at: "2026-09-23T00:00:00Z",
    text: `message ${id}`,
    channel: { source: "chat", thread: "t1", address: { message: id } },
    meta: {},
    ...overrides,
  };
}

/** A fake eve seam: runs live in a map, starts and signals are recorded, failures are programmable. */
class FakeEve implements EveForSuperagent {
  readonly starts: { ticketId: string; runId: string; objective: string; profileName: string; estimateUsd: string }[] =
    [];
  readonly signals: { agentRunId: string; text: string }[] = [];
  readonly cancels: string[] = [];
  readonly runsByRunId = new Map<string, LiveRun>();
  failNextSignal: Error | null = null;
  failNextStart: Error | null = null;
  private seq = 0;

  async liveRun({ runId }: { workspaceId: string; ticketId: string; runId: string }): Promise<LiveRun | undefined> {
    const found = this.runsByRunId.get(runId);
    return found && isActiveRunState(found.state) ? found : undefined;
  }
  async lastRun({ runId }: { workspaceId: string; ticketId: string; runId: string }): Promise<LiveRun | undefined> {
    return this.runsByRunId.get(runId);
  }
  async start(input: {
    workspaceId: string;
    auth: AuthContext;
    ticketId: string;
    runId: string;
    objective: string;
    profileName: string;
    estimateUsd: string;
  }): Promise<{ agentRunId: string }> {
    if (this.failNextStart) {
      const cause = this.failNextStart;
      this.failNextStart = null;
      throw cause;
    }
    this.starts.push(input);
    const agentRunId = `agent-${++this.seq}`;
    this.runsByRunId.set(input.runId, { agentRunId, state: "queued" });
    return { agentRunId };
  }
  async signal(input: { workspaceId: string; auth: AuthContext; agentRunId: string; text: string }): Promise<void> {
    if (this.failNextSignal) {
      const cause = this.failNextSignal;
      this.failNextSignal = null;
      throw cause;
    }
    this.signals.push({ agentRunId: input.agentRunId, text: input.text });
  }
  async cancel(input: { workspaceId: string; auth: AuthContext; agentRunId: string }): Promise<{ cancelled: boolean }> {
    this.cancels.push(input.agentRunId);
    return { cancelled: true };
  }
}

type RecordedEffect = { kind: "launch" | "delivery"; key: string; payload: Record<string, unknown> };

function isLaunchPayload(payload: object): payload is LaunchPayload {
  return (
    "ticketId" in payload &&
    "runId" in payload &&
    typeof payload.ticketId === "string" &&
    typeof payload.runId === "string"
  );
}

/**
 * The full harness: real engine over memory repositories with the real
 * executor as its Executor port, fake eve and effects around them. The drain
 * plays the effects module: every recorded effect runs through its handler
 * until the queue is empty, so a spec drives the whole
 * engine-command → effect → eve → engine-fact loop.
 */
export function harness(config: Partial<ExecutorConfig> = {}) {
  const repos = new MemoryRepositories();
  const eve = new FakeEve();
  const enqueued: RecordedEffect[] = [];
  const deferred: (() => Promise<void>)[] = [];

  const host: ExecutorHost = {
    workspaceId: WORKSPACE,
    repos,
    get engine() {
      // Late-wired: the Engine takes this executor as its port, so the engine
      // binding below is only read once construction has finished.
      return engine;
    },
    effects: { enqueue: (effect) => enqueued.push(effect) },
    eve,
    afterCommit: (work) => {
      deferred.push(work);
    },
    flush: async () => {},
    auth: async () => auth,
    config: { ...EXECUTOR_DEFAULTS, ...config },
  };
  const executor = createSuperagentExecutor(host);

  const policy: Policy = {
    version: "v1",
    paused: false,
    evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }),
    revalidate: () => true,
    admitsInferred: () => false,
  };
  const requests: Candidate[] = [];
  const assessor = {
    request: vi.fn((candidate: Candidate) => {
      requests.push(candidate);
    }),
    release: vi.fn(),
  };
  const outbox: OutboundMessage[] = [];
  const queued: EngineOptions["outbox"] = {
    send: (message) => {
      if (!outbox.some((item) => item.id === message.id)) outbox.push(message);
    },
    status: (id) => (outbox.some((item) => item.id === id) ? "pending" : undefined),
    withdraw: vi.fn(),
  };
  let clock = 0;
  const scope: EngineOptions["scope"] = { scope: () => ({ listened: true, observed: false }) };
  const engine = new Engine({
    repo: repos,
    scope,
    policy: () => policy,
    assessor,
    executor,
    outbox: queued,
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock++)).toISOString(),
  });

  /** Drain recorded effects the way the effects module would. */
  const drain = async (): Promise<void> => {
    for (;;) {
      const effect = enqueued.shift();
      if (!effect) return;
      if (!isLaunchPayload(effect.payload)) throw new Error(`malformed payload: ${JSON.stringify(effect.payload)}`);
      await (effect.kind === "launch"
        ? executor.handleLaunch(effect.payload)
        : executor.handleDelivery(effect.payload));
    }
  };
  const drainAfterCommit = async (): Promise<void> => {
    const pending = deferred.splice(0, deferred.length);
    for (const work of pending) await work();
  };

  /** A person's message on the given thread reaches tickets subscribed to it as an input. */
  const personSends = async (thread: string, triggerId: string): Promise<void> => {
    engine.receive(
      trig(triggerId, {
        threads: [{ source: "chat", id: thread }],
        channel: { source: "chat", thread, address: { message: triggerId } },
      }),
    );
    engine.evaluateDue();
    await drain();
  };

  /** Accept a ticket through the real pipeline and leave its first run pending (launch undrained). Each ticket lives on its own thread. */
  const acceptTicket = (id: string): Ticket => {
    const thread = `thr-${id}`;
    engine.receive(
      trig(`trig-${id}`, {
        text: `please ${id}`,
        threads: [{ source: "chat", id: thread }],
        channel: { source: "chat", thread, address: { message: id } },
      }),
    );
    engine.evaluateDue();
    const candidate = requests.at(-1);
    if (!candidate) throw new Error("no eval was requested");
    // The repo's active() order is not insertion order — pick the ticket this decide created.
    const known = new Set(repos.tickets.active().map((ticket) => ticket.id));
    engine.decide(candidate.triggers[0].id, {
      kind: "accept",
      title: `Fix ${id}`,
      scope: "small",
      reason: "requested",
      acknowledgement: "ok",
      assessmentId: candidate.assessmentId,
    });
    const ticket = repos.tickets.active().find((item) => !known.has(item.id));
    if (!ticket) throw new Error("the accept created no ticket");
    return ticket;
  };
  /** Leave a ticket's first run running and its launch effect drained, as after a healthy start. */
  const startTicket = async (id: string): Promise<Ticket> => {
    const ticket = acceptTicket(id);
    await drain();
    return repos.tickets.get(ticket.id)!;
  };

  /** Seed a ticket directly, with a running or pending run and an optional undelivered human input. */
  const seedTicket = (
    id: string,
    options: { running?: boolean; report?: TicketRun["report"]; undeliveredHuman?: boolean; botOrigin?: boolean } = {},
  ): Ticket => {
    const at = new Date(Date.UTC(2026, 8, 23, 0, 0, clock++)).toISOString();
    repos.triggers.save(
      trig(`trig-${id}`, {
        at,
        threads: [{ source: "chat", id: `thr-${id}` }],
        ...(options.botOrigin ? { human: false } : {}),
      }),
    );
    const run: TicketRun = {
      id: `run-${id}`,
      state: options.running ? "running" : "pending",
      createdAt: at,
      ...(options.running ? { startedAt: at } : {}),
      ...(options.report ? { report: options.report } : {}),
    };
    const input: TicketInput = {
      id: `in-${id}`,
      kind: "trigger",
      triggerId: `trig-${id}`,
      at,
      ...(options.botOrigin ? {} : { human: true as const }),
    };
    const ticket: Ticket = {
      id,
      title: `Ticket ${id}`,
      decisionId: `dec-${id}`,
      mandate: {
        strength: "explicit",
        policyVersion: "v1",
        basis: { via: "listed" },
        actor: { source: "chat", id: "alice" },
        scope: "Do the thing.",
      },
      channels: [{ source: "chat", thread: `thr-${id}`, address: { message: id } }],
      runs: [run],
      inputs: [input],
      undelivered: options.undeliveredHuman ? [input.id] : [],
      origin: { triggerId: `trig-${id}`, triggerIds: [`trig-${id}`] },
      createdAt: at,
      updatedAt: at,
    };
    repos.tickets.save(ticket);
    return ticket;
  };

  return {
    repos,
    engine,
    executor,
    eve,
    enqueued,
    deferred,
    drain,
    drainAfterCommit,
    personSends,
    acceptTicket,
    startTicket,
    seedTicket,
    ticket: (id: string) => repos.tickets.get(id)!,
  };
}
