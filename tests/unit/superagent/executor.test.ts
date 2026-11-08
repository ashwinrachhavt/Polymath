/**
 * The ticket executor's specs: the rules the acceptance evidence names, run
 * against the real executor over the real core engine with in-memory
 * repositories and a fake eve seam — the same discipline as the core-engine
 * specs (spec §4, §6). The harness lives in helpers/executor-harness.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { Ticket, TicketInput } from "@/domains/superagent/core";
import { admission, handedOff, parseExecutorConfig, spareEligible } from "@/domains/superagent/executor";
import { Later } from "@/domains/superagent/executor/errors";
import { inputMessage, launchObjective, triggerCard } from "@/domains/superagent/executor/messages";
import { harness, trig } from "./helpers/executor-harness";

describe("the Executor port enqueues effects only", () => {
  it("a start command enqueues exactly one launch effect for the run, and nothing executes", () => {
    const h = harness();
    const ticket = h.acceptTicket("1");
    const run = ticket.runs[0];
    expect(h.enqueued).toEqual([{ kind: "launch", key: run.id, payload: { ticketId: ticket.id, runId: run.id } }]);
    expect(h.eve.starts).toEqual([]);
    expect(run.state).toBe("pending");
    expect(h.deferred).toEqual([]);
  });

  it("a launch effect's drain starts one eve run and records the start", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    expect(h.eve.starts).toHaveLength(1);
    expect(h.eve.starts[0].ticketId).toBe(ticket.id);
    expect(h.eve.starts[0].runId).toBe(ticket.runs[0].id);
    expect(h.eve.starts[0].objective).toContain("small"); // the mandate's scope
    expect(h.eve.starts[0].objective).toContain("please 1"); // the origin request
    expect(h.eve.starts[0].profileName).toBe("polymath");
    const run = h.ticket(ticket.id).runs[0];
    expect(run.state).toBe("running");
    expect(run.startedAt).toBeTypeOf("string");
  });

  it("an input enqueues a delivery effect keyed by the ticket, and its drain carries the input to the session", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    h.enqueued.length = 0;
    h.engine.receive(trig("trig-2", { threads: [{ source: "chat", id: "thr-1" }] }));
    h.engine.evaluateDue();
    expect(h.enqueued.some((effect) => effect.kind === "delivery" && effect.key === ticket.id)).toBe(true);
    await h.drain();
    expect(h.eve.signals.map((signal) => signal.text)).toContainEqual(expect.stringContaining("message trig-2"));
    expect(h.ticket(ticket.id).undelivered).toEqual([]);
  });
});

describe("worker slots", () => {
  it("launches queue at capacity instead of starting, and the domain run stays pending", async () => {
    const h = harness();
    const a = await h.startTicket("a"); // the one regular slot, taken
    void a;
    const regular = h.seedTicket("c", { botOrigin: true }); // a bot-origin launch: holds the spare
    await expect(h.executor.handleLaunch({ ticketId: regular.id, runId: regular.runs[0].id })).rejects.toThrow(Later);
    expect(h.eve.starts).toHaveLength(1);
    expect(h.ticket(regular.id).runs[0].state).toBe("pending");
  });

  it("a person's message takes the spare slot a regular launch may not", async () => {
    const h = harness();
    const a = await h.startTicket("a");
    void a;
    // A fresh accept from a person: their message waits on the run, so its launch is a wake.
    const c = h.acceptTicket("c");
    h.enqueued.length = 0;
    await h.executor.handleLaunch({ ticketId: c.id, runId: c.runs[0].id });
    expect(h.eve.starts.map((start) => start.ticketId)).toEqual([a.id, c.id]);
    // The contrast: a regular (bot-origin) launch at the same count defers.
    const regular = h.seedTicket("r", { botOrigin: true });
    await expect(h.executor.handleLaunch({ ticketId: regular.id, runId: regular.runs[0].id })).rejects.toThrow(Later);
  });

  it("admission arithmetic: regular launches hold the spare, personal launches take it", () => {
    expect(admission(0, false, 2)).toBe("admit");
    expect(admission(1, false, 2)).toBe("defer");
    expect(admission(1, true, 2)).toBe("admit");
    expect(admission(0, true, 2)).toBe("admit");
    expect(admission(2, false, 3)).toBe("defer"); // both regular slots busy: the spare holds
    expect(admission(2, true, 3)).toBe("admit"); // a person takes the spare
  });

  it("spare eligibility: a person's message — origin or input — or a retry, never a plain run", () => {
    const h = harness();
    const triggerOf = (id: string) => h.repos.triggers.get(id);
    const fresh = h.seedTicket("f"); // a person's accept: the origin message waits on the run
    expect(spareEligible(fresh, triggerOf)).toBe(true);
    const waiting = h.seedTicket("w", { running: true, undeliveredHuman: true });
    expect(spareEligible(waiting, triggerOf)).toBe(true);
    const retry = h.seedTicket("r", {
      running: true,
      report: { state: "failed", summary: "nope", at: waiting.createdAt },
      botOrigin: true,
    });
    expect(spareEligible(retry, triggerOf)).toBe(true);
    const plain = h.seedTicket("p", { running: true, botOrigin: true });
    expect(spareEligible(plain, triggerOf)).toBe(false);
  });

  // Regression: ISSUE-001 — a run whose worker reported failed stays `running`
  // (its session parks for a person's reply) but no longer executes, yet
  // countRunning still counted it as a busy slot. Every chat launch then
  // deferred with "worker slots are full" until the queue filled with retries.
  // Found by /qa on 2026-11-08.
  it("a parked run (settled report, no delivery after) does not hold a worker slot", async () => {
    const h = harness();
    const stalled = h.seedTicket("z", {
      running: true,
      botOrigin: true,
      report: { state: "failed", summary: "model call failed", at: "2026-09-23T00:00:00.000Z" },
    });
    expect(h.ticket(stalled.id).runs[0].state).toBe("running");
    // The parked run frees both slots: a bot-origin launch admits again.
    const next = h.seedTicket("n", { botOrigin: true });
    await h.executor.handleLaunch({ ticketId: next.id, runId: next.runs[0].id });
    expect(h.eve.starts.map((start) => start.ticketId)).toContain(next.id);
  });

  it("config: at least two slots, integral, and a decimal estimate", () => {
    expect(() => parseExecutorConfig({ POLYMATH_SUPERAGENT_MAX_RUNNING: "1" })).toThrow(/at least 2/);
    expect(() => parseExecutorConfig({ POLYMATH_SUPERAGENT_MAX_RUNNING: "2.5" })).toThrow(/integer/);
    expect(() => parseExecutorConfig({ POLYMATH_SUPERAGENT_ESTIMATE_USD: "free" })).toThrow(/decimal/);
    const parsed = parseExecutorConfig({ POLYMATH_SUPERAGENT_MAX_RUNNING: "3", POLYMATH_SUPERAGENT_PROFILE: "other" });
    expect(parsed.maxRunning).toBe(3);
    expect(parsed.profileName).toBe("other");
  });
});

describe("one eve run per ticket run", () => {
  it("a replayed launch records the start instead of starting twice", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    const started = h.eve.starts.length;
    await h.executor.handleLaunch({ ticketId: ticket.id, runId: ticket.runs[0].id });
    expect(h.eve.starts.length).toBe(started);
    expect(h.ticket(ticket.id).runs[0].state).toBe("running");
  });

  it("a session that ended before the domain learned it started reports the failure, without a second run", async () => {
    const h = harness();
    const ticket = h.acceptTicket("1");
    h.eve.runsByRunId.set(ticket.runs[0].id, { agentRunId: "agent-dead", state: "failed" });
    await h.executor.handleLaunch({ ticketId: ticket.id, runId: ticket.runs[0].id });
    expect(h.eve.starts).toEqual([]);
    const run = h.ticket(ticket.id).runs[0];
    expect(run.report?.state).toBe("failed");
    expect(run.report?.summary).toContain("ended before it did any work");
  });

  it("a failed eve start reports the run failed with the cause", async () => {
    const h = harness();
    const ticket = h.acceptTicket("1");
    h.eve.failNextStart = new Error("profile unknown");
    await h.executor.handleLaunch({ ticketId: ticket.id, runId: ticket.runs[0].id });
    const run = h.ticket(ticket.id).runs[0];
    expect(run.report?.state).toBe("failed");
    expect(run.report?.summary).toContain("profile unknown");
    expect(run.state).toBe("pending"); // requeued, not lost
  });
});

describe("stop and handoff", () => {
  it("a stopped run whose last word was its report keeps its session", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    h.engine.report(ticket.id, { state: "waiting", summary: "waiting on input" });
    const run = h.ticket(ticket.id).runs[0];
    expect(handedOff(run)).toBe(true);
    h.executor.stop(h.ticket(ticket.id), run, "humanStopped");
    await h.drainAfterCommit();
    expect(h.eve.cancels).toEqual([]);
  });

  it("a stopped busy run — input arrived after its report — cancels the session after commit", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    h.engine.report(ticket.id, { state: "waiting", summary: "waiting on input" });
    await h.personSends("thr-1", "trig-9"); // busy: input reached the worker after the report
    const run = h.ticket(ticket.id).runs[0];
    expect(handedOff(run)).toBe(false);
    h.executor.stop(h.ticket(ticket.id), run, "humanStopped");
    await h.drainAfterCommit();
    expect(h.eve.cancels).toEqual([h.eve.runsByRunId.get(run.id)?.agentRunId]);
  });
});

describe("restart recovery", () => {
  it("reports interrupted runs oldest-first, restarting each with the check-prior-outputs note", async () => {
    const h = harness();
    h.seedTicket("t-3", {
      running: true,
      report: { state: "progress", summary: "mid-work", at: "2026-09-23T00:00:00Z" },
    });
    h.seedTicket("t-1", {
      running: true,
      report: { state: "progress", summary: "mid-work", at: "2026-09-23T00:00:00Z" },
    });
    h.seedTicket("t-2", {
      running: true,
      report: { state: "progress", summary: "mid-work", at: "2026-09-23T00:00:00Z" },
    });
    // Distinct startedAt: t-3 oldest, then t-1, then t-2 — insertion order must not decide.
    const withStarted = (ticket: Ticket, seconds: number): Ticket => ({
      ...ticket,
      runs: ticket.runs.map((run) => ({
        ...run,
        startedAt: new Date(Date.UTC(2026, 8, 23, 0, 0, seconds)).toISOString(),
      })),
    });
    h.repos.tickets.save(withStarted(h.ticket("t-3"), 10));
    h.repos.tickets.save(withStarted(h.ticket("t-1"), 20));
    h.repos.tickets.save(withStarted(h.ticket("t-2"), 30));

    const spy = vi.spyOn(h.engine, "runInterrupted");
    await h.executor.recover();
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["t-3", "t-1", "t-2"]);
    for (const id of ["t-3", "t-1", "t-2"]) {
      const ticket = h.ticket(id);
      expect(ticket.runs.at(-1)?.id).not.toBe(`run-${id}`); // restarted, not kept
      const note = ticket.inputs.find((input) => input.kind === "text");
      expect(note && note.kind === "text" ? note.text : "").toContain("Inspect the current worktree");
    }
  });

  it("cancels the old session after a restart, so no two sessions work one ticket", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    const oldRun = h.ticket(ticket.id).runs[0];
    h.engine.report(ticket.id, { state: "progress", summary: "mid-work" });
    await h.executor.recover(); // the run is busy: restart
    await h.drainAfterCommit();
    expect(h.eve.cancels).toEqual([h.eve.runsByRunId.get(oldRun.id)?.agentRunId]);
  });

  it("keeps a settled run's session: no restart, no cancel", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    h.engine.report(ticket.id, { state: "waiting", summary: "waiting on input" });
    const run = h.ticket(ticket.id).runs[0];
    await h.executor.recover();
    await h.drainAfterCommit();
    expect(h.ticket(ticket.id).runs).toHaveLength(1);
    expect(h.ticket(ticket.id).runs[0].id).toBe(run.id);
    expect(h.eve.cancels).toEqual([]);
  });
});

describe("delivery honesty", () => {
  it("a failed signal keeps the delivered prefix and throws for the queue to retry the rest", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    await h.personSends("thr-1", "trig-2"); // one input delivered cleanly first
    h.engine.receive(trig("trig-3", { threads: [{ source: "chat", id: "thr-1" }] }));
    h.engine.evaluateDue();
    h.eve.failNextSignal = new Error("session gone");
    await expect(h.drain()).rejects.toThrow("session gone");
    const after = h.ticket(ticket.id);
    const delivered = after.inputs.filter((input) => input.kind === "trigger" && input.deliveredTo !== undefined);
    expect(delivered).toHaveLength(1); // the prefix survived
    expect(after.delivery?.error).toContain("session gone");
    expect(after.undelivered).toHaveLength(1); // the rest waits for the queue's re-pass
  });

  it("a dead session records the failed delivery without throwing", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    h.enqueued.length = 0;
    await h.personSends("thr-1", "trig-2");
    h.eve.runsByRunId.delete(h.ticket(ticket.id).runs[0].id); // the session vanished without a report
    h.enqueued.length = 0;
    await h.personSends("thr-1", "trig-3");
    const after = h.ticket(ticket.id);
    expect(after.delivery?.error).toContain("no longer active");
  });

  it("a waiting session that takes every waiting message counts them read", async () => {
    const h = harness();
    const ticket = await h.startTicket("1");
    h.engine.report(ticket.id, { state: "waiting", summary: "waiting on input" });
    h.eve.runsByRunId.get(h.ticket(ticket.id).runs[0].id)!.state = "waiting_input"; // the session went idle
    await h.personSends("thr-1", "trig-4");
    const input = h
      .ticket(ticket.id)
      .inputs.find((candidate) => candidate.kind === "trigger" && candidate.triggerId === "trig-4");
    expect(input && input.kind === "trigger" ? input.readAt : undefined).toBeTypeOf("string");
  });
});

describe("what the executor says to a session", () => {
  it("caps long text and says what each message is before what it says", () => {
    const trigger = trig("trig-1", { text: "x".repeat(5000), human: false });
    const card = triggerCard(trigger);
    expect(card.length).toBeLessThan(4200);
    expect(card).toContain("An automated sender");
    const input: TicketInput = { id: "i", kind: "text", text: "plain", at: trigger.at };
    expect(inputMessage(input, () => undefined)).toBe("plain");
  });

  it("the objective carries the ticket's scope and its origin request", () => {
    const h = harness();
    const ticket = h.seedTicket("1");
    const objective = launchObjective(ticket, (id) => h.repos.triggers.get(id));
    expect(objective).toContain(ticket.id);
    expect(objective).toContain("Do the thing.");
    expect(objective).toContain("message trig-1");
  });

  it("carries the routed lane as a hint, and says nothing when the trigger was not routed", () => {
    const h = harness();
    const ticket = h.seedTicket("1");
    const plain = launchObjective(ticket, (id) => h.repos.triggers.get(id));
    expect(plain).not.toContain("Routing lane:");

    // The lane rides the trigger's durable meta (wiring.ts), so a replay of
    // the same ticket reaches the same hint without re-classifying.
    const routed = { ...h.repos.triggers.get("trig-1")!, meta: { lane: "research" } };
    const objective = launchObjective(ticket, () => routed);
    expect(objective).toContain("Routing lane: research");
    // A hint, not a policy: the scope line is still there.
    expect(objective).toContain("Scope of your mandate");
  });
});
