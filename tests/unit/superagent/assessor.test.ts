/**
 * The assessor specs: the real assessor port over the real core engine, with
 * in-memory repositories and fake eve / Decide seams around them (the
 * executor specs' harness pattern, reversed — here the assessor is the port
 * under test and the executor is the fake).
 *
 * Pinned here (spec §6, the assessor row): bounded context sizes enforced on
 * the session's only reading path; every decision outcome reachable through
 * the three eval tools; the decision record carrying the Eve judgment, the
 * Decide probability, and the final decision; expiry requeues twice, cancels
 * the stale session, then records unavailable.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/domains/identity/resolve";
import {
  Engine,
  MemoryRepositories,
  type Decision,
  type Policy,
  type Ticket,
  type TicketRun,
  type Trigger,
} from "@/domains/superagent/core";
import type { PolicyRule } from "@/domains/superagent/core/policy/gate";
import {
  ASSESSOR_DEFAULTS,
  createSuperagentAssessor,
  type AssessmentPayload,
  type AssessorConfig,
  type AssessorHost,
  type EvalJudgmentInput,
  type EvalReadPart,
  type EvalToolResult,
} from "@/domains/superagent/assessor";
import { EVAL_TOOLS, type EveForAssessor, type LiveEval } from "@/domains/superagent/assessor/eve";
import { Later } from "@/domains/superagent/effects/later";
import type { DecideClient, DecideRequest, DecideResponse } from "@/domains/superagent/decide";

// The Decisions call is held to the workspace's house allowance, which reads the database; the unit stubs the
// gate open. Its rules are proven in tests/integration/billing.test.ts.
vi.mock("@/domains/billing/resolver", () => ({
  withHouseCall: async (_workspaceId: string, _purpose: string, _call: unknown, run: () => Promise<unknown>) => run(),
}));

const WORKSPACE = "ws-1";
const auth: AuthContext = { userId: "owner-1", workspaceId: WORKSPACE, role: "owner" };
const at = "2026-09-23T00:00:00Z";

function trig(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: "chat",
    threads: [{ source: "chat", id: "t1" }],
    actor: { source: "chat", id: "alice" },
    human: true,
    at,
    text: `message ${id}`,
    channel: { source: "chat", thread: "t1", address: { message: id } },
    meta: {},
    ...overrides,
  };
}

/** A fake eval seam: sessions live in a map, starts and cancels are recorded. */
class FakeEvalEve implements EveForAssessor {
  readonly starts: {
    workspaceId: string;
    assessmentId: string;
    objective: string;
    profileName: string;
    estimateUsd: string;
    allowedTools: string[];
  }[] = [];
  readonly signals: { agentRunId: string; text: string }[] = [];
  readonly cancels: string[] = [];
  /** Assessment ids that already have a stored run — the replay check reads this. */
  readonly existing = new Map<string, LiveEval>();
  private seq = 0;

  async lastEval(input: { workspaceId: string; assessmentId: string }): Promise<LiveEval | undefined> {
    return this.existing.get(input.assessmentId);
  }
  async start(input: {
    workspaceId: string;
    auth: AuthContext;
    assessmentId: string;
    objective: string;
    profileName: string;
    estimateUsd: string;
    allowedTools: string[];
  }): Promise<{ agentRunId: string }> {
    this.starts.push(input);
    const agentRunId = `eval-agent-${++this.seq}`;
    this.existing.set(input.assessmentId, { agentRunId, state: "queued" });
    return { agentRunId };
  }
  async signal(input: { workspaceId: string; auth: AuthContext; agentRunId: string; text: string }): Promise<void> {
    this.signals.push({ agentRunId: input.agentRunId, text: input.text });
  }
  async cancel(input: { workspaceId: string; auth: AuthContext; agentRunId: string }): Promise<{ cancelled: boolean }> {
    this.cancels.push(input.agentRunId);
    return { cancelled: true };
  }
}

/** A fake Mercury Decide client: recorded calls, one calibrated answer, an optional failure. */
function fakeDecide(
  probability: number,
  options: { fail?: boolean } = {},
): { client: DecideClient; requests: DecideRequest[] } {
  const requests: DecideRequest[] = [];
  const client: DecideClient = {
    decide: async (request) => {
      requests.push(request);
      if (options.fail) throw new Error("decide is down");
      const answer: DecideResponse["answers"][string] = { type: "noul", probability };
      return { model: "mercury-decide", answers: { admit: answer }, usage: { inputTokens: 120, outputTokens: 0 } };
    },
  };
  return { client, requests };
}

const rules: PolicyRule[] = [
  { id: "triage", name: "Bug triage", enabled: true, instruction: "Accept bug reports that name a failing behavior." },
  { id: "reports", name: "Weekly reports", enabled: true, instruction: "Draft the weekly report on request." },
];

function harness(
  options: { config?: Partial<AssessorConfig>; decide?: DecideClient | null; policyRules?: PolicyRule[] } = {},
) {
  const repos = new MemoryRepositories();
  const eve = new FakeEvalEve();
  const enqueued: (
    | { kind: "assessment"; key: string; payload: Record<string, unknown> }
    | { kind: "reap"; key: string; availableAt: string }
  )[] = [];
  /** Every effect ever enqueued — the working queue above is drained, this is the record. */
  const seen: (
    | { kind: "assessment"; key: string; payload: Record<string, unknown> }
    | { kind: "reap"; key: string; availableAt: string }
  )[] = [];
  const deferred: (() => Promise<void>)[] = [];

  const host: AssessorHost = {
    workspaceId: WORKSPACE,
    repos,
    get engine() {
      // Late-wired: the Engine takes this assessor as its port, so the engine
      // binding below is only read once construction has finished.
      return engine;
    },
    effects: {
      enqueue: (effect) => {
        enqueued.push(effect);
        seen.push(effect);
      },
    },
    eve,
    decide: options.decide ?? null,
    afterCommit: (work) => {
      deferred.push(work);
    },
    flush: async () => {},
    auth: async () => auth,
    policyView: () => ({ rules: options.policyRules ?? [], mode: "auto" }),
    config: { ...ASSESSOR_DEFAULTS, ...options.config },
  };
  const assessor = createSuperagentAssessor(host);

  const policy: Policy = {
    version: "v1",
    paused: false,
    evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }),
    revalidate: () => true,
    admitsInferred: () => false,
  };
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() };
  let clock = 0;
  const engine = new Engine({
    repo: repos,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor,
    executor,
    outbox: { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() },
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock++)).toISOString(),
  });

  /** Drain recorded effects the way the effects module would. */
  const drain = async (): Promise<void> => {
    for (;;) {
      const effect = enqueued.shift();
      if (!effect) return;
      // The real reap handler ticks the workspace (evaluateDue + flush); the
      // expiry tests below drive that tick themselves, so the harness only
      // consumes the effect.
      if (effect.kind === "reap") continue;
      await assessor.handleAssessment(effect.payload as unknown as AssessmentPayload);
    }
  };
  const drainAfterCommit = async (): Promise<void> => {
    const pending = deferred.splice(0, deferred.length);
    for (const work of pending) await work();
  };
  /** The engine's due pass, then the assessment effects it enqueued. */
  const pump = async (): Promise<void> => {
    engine.evaluateDue();
    await drain();
  };
  /** Advance the harness clock without ticking the engine's own now(). */
  const tick = (seconds: number): void => {
    clock += seconds;
  };

  const requests = (): AssessmentPayload[] =>
    seen
      .filter((effect) => effect.kind === "assessment")
      .map((effect) => effect.payload as unknown as AssessmentPayload);
  const decisions = (): Decision[] => repos.decisions.byThread("chat:t1");

  /** A person's message on the default thread: received, evaluated, its assessment drained. */
  const personSends = async (id: string): Promise<void> => {
    engine.receive(trig(id));
    await pump();
  };

  /** Act as the eval session: the three tools, scoped to one assessment. */
  const session = (assessmentId: string) => ({
    read: async (part: EvalReadPart): Promise<EvalToolResult> => assessor.tools.read(assessmentId, part),
    judge: async (judgment: EvalJudgmentInput): Promise<EvalToolResult> => assessor.tools.judge(assessmentId, judgment),
    decide: async (): Promise<EvalToolResult> => assessor.tools.decide(assessmentId),
  });

  /**
   * Seed tickets on the default thread and subscribe the thread to them —
   * after a receive has created the thread, so the candidate gathers them.
   */
  const seedTickets = (count: number, seed: (index: number) => Partial<Ticket> = () => ({})): Ticket[] => {
    const made: Ticket[] = [];
    for (let index = 0; index < count; index++) {
      const id = `t-${index}`;
      const createdAt = new Date(Date.UTC(2026, 8, 23, 0, 0, index)).toISOString();
      const run: TicketRun = { id: `run-${id}`, state: "pending", createdAt };
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
        channels: [{ source: "chat", thread: "t1", address: { message: id } }],
        runs: [run],
        inputs: [],
        undelivered: [],
        origin: { triggerId: `trig-${id}`, triggerIds: [`trig-${id}`] },
        createdAt,
        updatedAt: createdAt,
        ...seed(index),
      };
      repos.tickets.save(ticket);
      repos.triggers.save(trig(`trig-${id}`, { text: `please ${id}` }));
      made.push(ticket);
    }
    const thread = repos.threads.get("chat:t1");
    if (thread) repos.threads.save({ ...thread, subscriptions: made.map((ticket) => ticket.id) });
    return made;
  };

  return {
    repos,
    engine,
    assessor,
    eve,
    enqueued,
    seen,
    deferred,
    drain,
    drainAfterCommit,
    pump,
    tick,
    requests,
    decisions,
    personSends,
    session,
    seedTickets,
  };
}

describe("requesting an assessment", () => {
  it("enqueues one assessment effect per candidate, keyed by the assessment id", async () => {
    const h = harness();
    await h.personSends("1");
    expect(h.requests()).toHaveLength(1);
    const { assessmentId } = h.requests()[0]!;
    expect(h.seen[0]).toMatchObject({
      kind: "assessment",
      key: assessmentId,
      payload: { assessmentId, threadKey: "chat:t1" },
    });
  });

  it("starts one session on the dedicated profile, pinned to the three eval tools, briefed with the bounded candidate", async () => {
    const h = harness({ policyRules: rules });
    await h.personSends("1");
    expect(h.eve.starts).toHaveLength(1);
    const start = h.eve.starts[0]!;
    expect(start.profileName).toBe(ASSESSOR_DEFAULTS.profileName);
    expect(start.allowedTools).toEqual([...EVAL_TOOLS]);
    expect(start.objective).toContain("## Facts");
    expect(start.objective).toContain("## Rules");
    expect(start.objective).toContain("## Message data");
  });

  it("records delivery, so the eval's deadline counts from the session's first turn", async () => {
    const h = harness();
    await h.personSends("1");
    const assessmentId = h.requests()[0]!.assessmentId;
    expect(h.repos.threads.get("chat:t1")!.evaluating?.id).toBe(assessmentId);
    expect(h.repos.threads.get("chat:t1")!.evaluating?.delivered).toBeTruthy();
  });

  it("never starts a second session for an assessment whose session already exists", async () => {
    const h = harness();
    await h.personSends("1");
    const payload = h.requests()[0]!;
    // The effect replays (a drain that started the session and died before
    // recording delivered): the stored run is found, no second start.
    await h.assessor.handleAssessment(payload);
    await h.assessor.handleAssessment(payload);
    expect(h.eve.starts).toHaveLength(1);
    expect(h.repos.threads.get("chat:t1")!.evaluating?.delivered).toBeTruthy();
  });

  it("defers an assessment past the session cap without failing it, and starts it when a slot frees", async () => {
    const h = harness({ config: { maxConcurrent: 1 } });
    await h.personSends("1");
    // A message on another thread: received and evaluated, but its assessment
    // drains into a full slot.
    h.engine.receive(
      trig("2", {
        threads: [{ source: "chat", id: "t2" }],
        channel: { source: "chat", thread: "t2", address: { message: "2" } },
      }),
    );
    h.engine.evaluateDue();
    const deferredPayload = h.requests().at(-1)!;
    // The deferred drain throws Later — parked, not failed; no failure counters move.
    await expect(h.assessor.handleAssessment(deferredPayload)).rejects.toThrow(Later);
    expect(h.eve.starts).toHaveLength(1);
    // The first eval decides, its slot frees, and the parked assessment starts.
    const first = h.session(h.requests()[0]!.assessmentId);
    await first.judge({ outcome: "ignore", reason: "not work" });
    await first.decide();
    await h.assessor.handleAssessment(deferredPayload);
    expect(h.eve.starts).toHaveLength(2);
  });
});

describe("the session's bounded reading", () => {
  it("caps a trigger's text at 4000 characters on the read tool, keeping its audit fields", async () => {
    const h = harness();
    h.engine.receive(trig("1", { text: "x".repeat(5000) }));
    await h.pump();
    const read = await h.session(h.requests()[0]!.assessmentId).read("triggers");
    if (!("content" in read)) throw new Error("expected content");
    expect(read.content).toContain(`${"x".repeat(4000)}…`);
    expect(read.content).not.toContain("x".repeat(4500));
    // Audit fields survive the cap: the trigger's id and actor are on the card.
    expect(read.content).toContain("[1] at 2026-09-23T00:00:00.000Z by chat:alice");
  });

  it("shows at most eight ticket cards — live first, newest first — and says honestly what it dropped", async () => {
    const h = harness();
    h.engine.receive(trig("1"));
    h.seedTickets(10);
    await h.pump();
    const read = await h.session(h.requests()[0]!.assessmentId).read("tickets");
    if (!("content" in read)) throw new Error("expected content");
    // The newest live tickets survive the cut; the oldest do not.
    expect(read.content).toContain("t-9");
    expect(read.content).not.toContain("t-0]");
    expect(read.content).toContain("2 more not shown");
  });

  it("caps a ticket's origin message at 400 characters on the read tool", async () => {
    const h = harness();
    h.engine.receive(trig("1"));
    h.seedTickets(1);
    // The origin trigger's stored text is what the card quotes.
    h.repos.triggers.save(trig("trig-t-0", { text: "y".repeat(600) }));
    await h.pump();
    const read = await h.session(h.requests()[0]!.assessmentId).read("tickets");
    if (!("content" in read)) throw new Error("expected content");
    expect(read.content).toContain(`${"y".repeat(400)}…`);
    expect(read.content).not.toContain("y".repeat(500));
  });

  it("reads the enabled rules, and says when none are enabled", async () => {
    const withRules = harness({ policyRules: rules });
    await withRules.personSends("1");
    const read = await withRules.session(withRules.requests()[0]!.assessmentId).read("rules");
    if (!("content" in read)) throw new Error("expected content");
    expect(read.content).toContain("[triage] Bug triage: Accept bug reports that name a failing behavior.");
    expect(read.content).toContain("[reports] Weekly reports: Draft the weekly report on request.");

    const withoutRules = harness();
    await withoutRules.personSends("1");
    const bare = await withoutRules.session(withoutRules.requests()[0]!.assessmentId).read("rules");
    if (!("content" in bare)) throw new Error("expected content");
    expect(bare.content).toContain("no admission rules are enabled");
  });

  it("reads the thread card: key, strength, policy version, and the honest ticket count", async () => {
    const h = harness();
    h.engine.receive(trig("1"));
    h.seedTickets(3);
    await h.pump();
    const read = await h.session(h.requests()[0]!.assessmentId).read("thread");
    if (!("content" in read)) throw new Error("expected content");
    expect(read.content).toContain("chat:t1");
    expect(read.content).toContain("explicit");
    expect(read.content).toContain("v1");
    expect(read.content).toContain("Tickets on this thread: 3 (0 not shown)");
  });
});

describe("the decision seam — every outcome reachable", () => {
  it("accepts: Eve's judgment and Decide's probability agree, the ticket opens, and the record carries all three parts", async () => {
    const decide = fakeDecide(0.9);
    const h = harness({ decide: decide.client, policyRules: rules });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({
      outcome: "accept",
      title: "Fix the flaky test",
      scope: "Reproduce and pin it",
      reason: "explicit request",
      rules: ["triage"],
    });
    const result = await s.decide();
    expect(result).toMatchObject({
      outcome: "accept",
      decidedBy: "eve",
      decide: { admitProbability: 0.9, model: "mercury-decide" },
    });
    const decision = h.decisions().at(-1)!;
    expect(decision.kind).toBe("accept");
    // The Assessment records the Eve judgment, the Decide probability, and the final decision.
    const record = decision.audit!.decision as {
      eve: { outcome: string; rules?: string[] };
      decide: { admitProbability: number } | null;
      final: { kind: string; decidedBy: string };
    };
    expect(record.eve.outcome).toBe("accept");
    expect(record.eve.rules).toEqual(["triage"]);
    expect(record.decide!.admitProbability).toBe(0.9);
    expect(record.final).toEqual({ kind: "accept", decidedBy: "eve" });
    // The accept opened the ticket, titled and scoped from the judgment.
    const ticket = h.repos.tickets.active().find((item) => item.title === "Fix the flaky test");
    expect(ticket?.mandate.scope).toBe("Reproduce and pin it");
    // The calibration read the bounded, stored-meta state.
    expect(decide.requests).toHaveLength(1);
    const state = decide.requests[0]!.state as { candidate: { strength: string }; messages: { text: string }[] };
    expect(state.candidate.strength).toBe("explicit");
    expect(state.messages[0]!.text).toBe("message 1");
  });

  it("escalates below threshold: an Eve acceptance under Decide's threshold is recorded not-admitted, panel-visible", async () => {
    const decide = fakeDecide(0.3);
    const h = harness({ decide: decide.client });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "accept", title: "Do it", scope: "The thing", reason: "requested" });
    const result = await s.decide();
    expect(result).toMatchObject({
      outcome: "ignore",
      decidedBy: "escalated",
      escalation: "belowThreshold",
      decide: { admitProbability: 0.3 },
    });
    const decision = h.decisions().at(-1)!;
    expect(decision.kind).toBe("ignore");
    expect(decision.reason).toEqual([
      {
        code: "decideBelowThreshold",
        values: { probability: "0.3", threshold: String(ASSESSOR_DEFAULTS.admitThreshold) },
      },
    ]);
    expect((decision.audit!.decision as { final: { escalation?: string } }).final.escalation).toBe("belowThreshold");
    expect(h.repos.tickets.active()).toEqual([]); // never admitted over the threshold
  });

  it("escalates disagreement: Eve would not admit but Decide reached the threshold — still never admitted", async () => {
    const decide = fakeDecide(0.9);
    const h = harness({ decide: decide.client });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "ignore", reason: "already covered" });
    const result = await s.decide();
    expect(result).toMatchObject({
      outcome: "ignore",
      decidedBy: "escalated",
      escalation: "disagreement",
      decide: { admitProbability: 0.9 },
    });
    const decision = h.decisions().at(-1)!;
    expect(decision.reason).toEqual([
      {
        code: "decideDisagreement",
        values: { probability: "0.9", threshold: String(ASSESSOR_DEFAULTS.admitThreshold) },
      },
    ]);
    expect(h.repos.tickets.active()).toEqual([]);
  });

  it("ignores plainly: Eve's ignore with Decide under the threshold is Eve's own call", async () => {
    const decide = fakeDecide(0.2);
    const h = harness({ decide: decide.client });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "ignore", reason: "a duplicate of earlier work" });
    const result = await s.decide();
    expect(result).toMatchObject({ outcome: "ignore", decidedBy: "eve" });
    expect(result).not.toHaveProperty("escalation");
    expect(h.decisions().at(-1)!.kind).toBe("ignore");
    expect(h.repos.tickets.active()).toEqual([]);
  });

  it("stops: Eve's stop ends the named ticket whatever the probability said", async () => {
    const decide = fakeDecide(0.1);
    const h = harness({ decide: decide.client });
    h.engine.receive(trig("2"));
    const [seeded] = h.seedTickets(1);
    await h.pump();
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "stop", ticketId: seeded!.id, reason: "the person asked to stop this" });
    const result = await s.decide();
    expect(result).toMatchObject({ outcome: "stop", decidedBy: "eve" });
    const decision = h.decisions().at(-1)!;
    expect(decision.kind).toBe("stop");
    expect(decision.ticketId).toBe(seeded!.id);
    expect(h.repos.tickets.get(seeded!.id)!.ended).toBeTruthy();
  });

  it("records unavailable: Eve could not judge", async () => {
    const decide = fakeDecide(0.8);
    const h = harness({ decide: decide.client });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "unavailable", reason: "the stored state is contradictory" });
    const result = await s.decide();
    expect(result).toMatchObject({ outcome: "unavailable", decidedBy: "eve" });
    expect(h.decisions().at(-1)!.kind).toBe("unavailable");
    expect(h.repos.tickets.active()).toEqual([]);
  });

  it("decides from Eve alone when the Decide call fails — the record shows the absence, not an invented probability", async () => {
    const decide = fakeDecide(1, { fail: true });
    const h = harness({ decide: decide.client });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "accept", title: "Fix it", scope: "The scope", reason: "requested" });
    const result = await s.decide();
    expect(result).toMatchObject({ outcome: "accept", decidedBy: "eve", decide: null });
    const record = h.decisions().at(-1)!.audit!.decision as { decide: unknown; final: { decidedBy: string } };
    expect(record.decide).toBeNull();
    expect(record.final.decidedBy).toBe("eve");
    expect(h.repos.tickets.active()).toHaveLength(1); // a down second provider never hard-stops admission
  });

  it("decides from Eve alone when no Decide client is configured", async () => {
    const h = harness({ decide: null });
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "accept", title: "Fix it", scope: "The scope", reason: "requested" });
    const result = await s.decide();
    expect(result).toMatchObject({ outcome: "accept", decidedBy: "eve", decide: null });
    expect(h.repos.tickets.active()).toHaveLength(1);
  });
});

describe("session discipline", () => {
  it("refuses a decision with no judgment recorded", async () => {
    const h = harness();
    await h.personSends("1");
    const result = await h.session(h.requests()[0]!.assessmentId).decide();
    expect(result).toMatchObject({ error: expect.stringContaining("no judgment is recorded") });
  });

  it("refuses a judgment without a reason, an accept without title and scope, and a stop without a ticket", async () => {
    const h = harness();
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    expect(await s.judge({ outcome: "ignore", reason: "  " })).toMatchObject({
      error: expect.stringContaining("reason"),
    });
    expect(await s.judge({ outcome: "accept", reason: "why not", title: "", scope: "" })).toMatchObject({
      error: expect.stringContaining("title and a concrete scope"),
    });
    expect(await s.judge({ outcome: "stop", reason: "why" })).toMatchObject({
      error: expect.stringContaining("names the ticket"),
    });
  });

  it("tells the session its state is stored once the evaluation has finished", async () => {
    const h = harness();
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "ignore", reason: "not work" });
    await s.decide();
    // The eval has ended; every tool now refuses rather than judging from stale memory.
    expect(await s.read("triggers")).toMatchObject({ error: expect.stringContaining("no longer running") });
    expect(await s.judge({ outcome: "ignore", reason: "again" })).toMatchObject({
      error: expect.stringContaining("no longer running"),
    });
    expect(await s.decide()).toMatchObject({ error: expect.stringContaining("no longer running") });
  });
});

describe("expiry — requeues twice, cancels the stale session, then records unavailable", () => {
  it("expires twice with a fresh session each requeue, cancels each stale session after commit, and the third expiry records unavailable", async () => {
    const h = harness();
    await h.personSends("1");
    expect(h.eve.starts).toHaveLength(1);
    expect(h.decisions()).toEqual([]);

    // The first expiry: the eval is released, its session cancelled after
    // commit, and the trigger queued for a fresh eval.
    h.tick(61);
    h.engine.evaluateDue();
    await h.drain();
    expect(h.requests()).toHaveLength(2);
    expect(h.eve.starts).toHaveLength(2);
    expect(h.decisions()).toEqual([]); // an expiry records nothing by itself
    await h.drainAfterCommit();
    expect(h.eve.cancels).toEqual(["eval-agent-1"]);

    // The second expiry: one more session, one more cancel.
    h.tick(61);
    h.engine.evaluateDue();
    await h.drain();
    expect(h.requests()).toHaveLength(3);
    expect(h.eve.starts).toHaveLength(3);
    await h.drainAfterCommit();
    expect(h.eve.cancels).toEqual(["eval-agent-1", "eval-agent-2"]);

    // The third expiry records unavailable.
    h.tick(61);
    h.engine.evaluateDue();
    await h.drain();
    expect(h.eve.starts).toHaveLength(3); // no fourth session
    expect(h.decisions()).toEqual([expect.objectContaining({ kind: "unavailable", reason: [{ code: "timeout" }] })]);
    expect(h.repos.threads.get("chat:t1")).toMatchObject({ pending: [] });
    expect(h.repos.threads.get("chat:t1")!.evaluating).toBeUndefined();
  });

  it("does not cancel a session whose eval decided — only a stale one", async () => {
    const h = harness();
    await h.personSends("1");
    const s = h.session(h.requests()[0]!.assessmentId);
    await s.judge({ outcome: "ignore", reason: "not work" });
    await s.decide();
    await h.drainAfterCommit();
    expect(h.eve.cancels).toEqual([]);
  });
});

describe("scheduleReap — the deadline's observer", () => {
  it("enqueues a reap effect when the candidate is delivered, due exactly at the deadline its policy set", async () => {
    const h = harness();
    await h.personSends("1");
    const assessmentId = h.requests()[0]!.assessmentId;
    const thread = h.repos.threads.get("chat:t1")!;
    // The candidate's delivery — the session reporting through the drained
    // assessment effect — schedules the deadline's observer itself: one reap
    // effect, coalesced on the assessment, due exactly at the stored deadline.
    expect(h.seen.filter((effect) => effect.kind === "reap")).toEqual([
      { kind: "reap", key: assessmentId, availableAt: thread.evaluating!.deadline },
    ]);
    // And the observed deadline counts from the delivery, not the request.
    expect(Date.parse(thread.evaluating!.deadline) - Date.parse(thread.evaluating!.delivered!)).toBe(60_000);
  });
});
