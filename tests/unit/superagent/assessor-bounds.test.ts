/**
 * The assessor's bounded-context specs (spec §4): a candidate reaches the
 * assessor's session only through the bounds — trigger text 4000 chars, at
 * most eight ticket cards, 400-char messages. `boundCandidate` is the single
 * enforcement point, pure and deterministic, so the caps hold wherever a
 * candidate is rendered or calibrated.
 */
import { describe, expect, it } from "vitest";
import type { Ticket, TicketRun, Trigger, WorkThread } from "@/domains/superagent/core";
import { MESSAGE_CAP, TICKET_VIEW_LIMIT, TRIGGER_TEXT_CAP, boundCandidate } from "@/domains/superagent/assessor/bounds";

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

function ticketFixture(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
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
    channels: [],
    runs: [],
    inputs: [],
    undelivered: [],
    origin: { triggerId: `trig-${id}`, triggerIds: [`trig-${id}`] },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const thread: WorkThread = {
  key: "chat:t1",
  ref: { source: "chat", id: "t1" },
  createdAt: at,
  subscriptions: [],
  correlated: [],
  pending: [],
  meta: {},
};

describe("the bounds constants", () => {
  it("are the spec's numbers: 4000-char triggers, eight tickets, 400-char messages", () => {
    expect(TRIGGER_TEXT_CAP).toBe(4000);
    expect(TICKET_VIEW_LIMIT).toBe(8);
    expect(MESSAGE_CAP).toBe(400);
  });
});

describe("boundCandidate", () => {
  it("caps a trigger's text at 4000 characters, marking the cut", () => {
    const long = "x".repeat(5000);
    const bounded = boundCandidate(
      {
        assessmentId: "as-1",
        thread,
        triggers: [trig("trig-1", { text: long })],
        strength: "explicit",
        policyVersion: "v1",
        tickets: [],
      },
      () => undefined,
    );
    expect(bounded.triggers[0]!.text).toBe(`${"x".repeat(4000)}…`);
    expect(bounded.triggers[0]!.id).toBe("trig-1");
  });

  it("keeps a trigger's audit fields beside its capped text", () => {
    const bounded = boundCandidate(
      {
        assessmentId: "as-1",
        thread,
        triggers: [trig("trig-1", { human: false, actor: { source: "chat", id: "ci-bot" }, addressed: "mention" })],
        strength: "inferred",
        policyVersion: "v1",
        tickets: [],
      },
      () => undefined,
    );
    const boundedTrigger = bounded.triggers[0]!;
    expect(boundedTrigger.human).toBe(false);
    expect(boundedTrigger.actor).toEqual({ source: "chat", id: "ci-bot" });
    expect(boundedTrigger.addressed).toBe("mention");
    expect(boundedTrigger.at).toBe(at);
  });

  it("caps ticket messages at 400 characters", () => {
    const longOrigin = trig("trig-t-1", { text: "y".repeat(600) });
    const bounded = boundCandidate(
      {
        assessmentId: "as-1",
        thread,
        triggers: [trig("trig-1")],
        strength: "explicit",
        policyVersion: "v1",
        tickets: [ticketFixture("t-1")],
      },
      (id) => (id === "trig-t-1" ? longOrigin : undefined),
    );
    expect(bounded.tickets[0]!.originText).toBe(`${"y".repeat(400)}…`);
  });

  it("shows at most eight tickets — live first, newest first — and counts what it dropped", () => {
    const live = Array.from({ length: 9 }, (_, index) =>
      ticketFixture(`live-${index}`, {
        createdAt: new Date(Date.UTC(2026, 8, 23, 0, 0, index)).toISOString(),
      }),
    );
    const ended = ticketFixture("ended-1", {
      createdAt: new Date(Date.UTC(2026, 8, 23, 0, 0, 20)).toISOString(),
      ended: { at, by: "executor", outcome: "completed" },
    });
    const bounded = boundCandidate(
      {
        assessmentId: "as-1",
        thread,
        triggers: [trig("trig-1")],
        strength: "explicit",
        policyVersion: "v1",
        tickets: [ended, ...live],
      },
      () => undefined,
    );
    expect(bounded.tickets).toHaveLength(TICKET_VIEW_LIMIT);
    expect(bounded.ticketTotal).toBe(10);
    expect(bounded.droppedTickets).toBe(2);
    // The newest live tickets survive the cut; the oldest and the ended one do not.
    expect(bounded.tickets.map((ticket) => ticket.id)).not.toContain("live-0");
    expect(bounded.tickets.map((ticket) => ticket.id)).not.toContain("ended-1");
    expect(bounded.tickets.map((ticket) => ticket.id)).toContain("live-8");
  });

  it("carries a ticket's latest report, with its summary capped", () => {
    const run: TicketRun = {
      id: "run-1",
      state: "ended",
      createdAt: at,
      report: { state: "blocked", summary: "z".repeat(500), at },
    };
    const bounded = boundCandidate(
      {
        assessmentId: "as-1",
        thread,
        triggers: [trig("trig-1")],
        strength: "explicit",
        policyVersion: "v1",
        tickets: [ticketFixture("t-1", { runs: [run] })],
      },
      () => undefined,
    );
    expect(bounded.tickets[0]!.report).toEqual({ state: "blocked", summary: `${"z".repeat(400)}…`, at });
  });

  it("renders an open and an ended ticket's state honestly", () => {
    const bounded = boundCandidate(
      {
        assessmentId: "as-1",
        thread,
        triggers: [trig("trig-1")],
        strength: "explicit",
        policyVersion: "v1",
        tickets: [
          ticketFixture("open-1"),
          ticketFixture("done-1", { ended: { at, by: "executor", outcome: "completed" } }),
        ],
      },
      () => undefined,
    );
    expect(bounded.tickets[0]!.ended).toBe(false);
    expect(bounded.tickets[1]!.ended).toBe(true);
    expect(bounded.tickets[1]!.outcome).toBe("completed");
  });
});
