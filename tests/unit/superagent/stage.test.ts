import { describe, expect, it } from "vitest";
import { canRetry, ticketStage, type TicketRun, type ReportState, type Ticket } from "@/domains/superagent/core";

const run = (overrides: Partial<TicketRun> = {}): TicketRun => ({
  id: "a",
  state: "running",
  createdAt: "",
  ...overrides,
});
const reported = (state: ReportState, overrides: Partial<TicketRun> = {}) =>
  run({ report: { state, summary: "", at: "" }, ...overrides });
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "t",
  title: "x",
  decisionId: "d",
  mandate: {
    strength: "explicit",
    policyVersion: "v",
    basis: { via: "listed" },
    actor: { source: "chat", id: "ou" },
    scope: "",
  },
  channels: [],
  runs: [run()],
  inputs: [],
  undelivered: [],
  createdAt: "",
  updatedAt: "",
  origin: { triggerId: "x", triggerIds: ["x"] },
  ...overrides,
});
const attention = { id: "q", question: "?" };
/** A person's message that reached the Ticket after its report. */
const answered = { inputs: [{ id: "i", kind: "trigger" as const, triggerId: "e", at: "later", human: true as const }] };
const reportedAt = (state: ReportState) => reported(state, { report: { state, summary: "", at: "earlier" } });
const ended = { at: "", by: "executor" as const, reason: "closed", outcome: "closed" as const };

// The rows of the docs/003 table, in order; a Ticket that matches several rows takes the first.
describe("ticketStage", () => {
  it.each([
    [
      "an undelivered Input",
      ticket({ delivery: { error: "offline", at: "" } }),
      { stage: "person", action: "delivery" },
    ],
    [
      "delivery before answer and review",
      ticket({ delivery: { error: "offline", at: "" }, attention, runs: [reported("ready")] }),
      { stage: "person", action: "delivery" },
    ],
    ["an Attention", ticket({ attention }), { stage: "person", action: "answer" }],
    ["answer before review", ticket({ attention, runs: [reported("ready")] }), { stage: "person", action: "answer" }],
    [
      "answer before a failure",
      ticket({ attention, runs: [reported("failed")] }),
      { stage: "person", action: "answer" },
    ],
    ["a ready Report", ticket({ runs: [reported("ready")] }), { stage: "person", action: "review" }],
    [
      "a ready Report of an ended TicketRun",
      ticket({ runs: [reported("ready", { state: "ended" })] }),
      { stage: "person", action: "review" },
    ],
    ["a blocked Report", ticket({ runs: [reported("blocked")] }), { stage: "person", action: "blocked" }],
    ["a failed Report", ticket({ runs: [reported("failed")] }), { stage: "person", action: "failed" }],
    [
      "a blocked Report a person answered since",
      ticket({ ...answered, runs: [reportedAt("blocked")] }),
      { stage: "working" },
    ],
    ["no TicketRun", ticket({ runs: [] }), { stage: "working", action: "queued" }],
    [
      "a pending TicketRun",
      ticket({ runs: [reported("failed", { state: "ended" }), run({ state: "pending" })] }),
      { stage: "working", action: "queued" },
    ],
    ["a waiting Report", ticket({ runs: [reported("waiting")] }), { stage: "idle" }],
    ["an ended TicketRun", ticket({ runs: [run({ state: "ended" })] }), { stage: "idle" }],
    ["a running TicketRun", ticket(), { stage: "working" }],
    ["a progress Report", ticket({ runs: [reported("progress")] }), { stage: "working" }],
    ["an ended Ticket", ticket({ ended, attention, runs: [reported("failed")] }), { stage: "ended" }],
  ])("%s", (_name, value, stage) => {
    expect(ticketStage(value)).toEqual(stage);
  });
});

describe("canRetry", () => {
  it.each([
    ["a failed open Ticket", true, ticket({ runs: [reported("failed")] })],
    ["a blocked open Ticket", true, ticket({ runs: [reported("blocked")] })],
    ["a failed Ticket that also awaits an answer", true, ticket({ attention, runs: [reported("failed")] })],
    [
      "a blocked Ticket whose Input is undelivered",
      true,
      ticket({ delivery: { error: "offline", at: "" }, runs: [reported("blocked")] }),
    ],
    ["a failed Ticket that ended", false, ticket({ ended, runs: [reported("failed")] })],
    [
      "a Ticket retried already, whose new TicketRun is pending",
      false,
      ticket({ runs: [reported("failed", { state: "ended" }), run({ state: "pending" })] }),
    ],
    ["a ready Ticket", false, ticket({ runs: [reported("ready")] })],
    ["a running Ticket", false, ticket()],
    ["a Ticket without an TicketRun", false, ticket({ runs: [] })],
    // The worker has the person's message, as the Ticket's stage says, so a retry would only interrupt it.
    ["a failed Ticket a person answered since", false, ticket({ ...answered, runs: [reportedAt("failed")] })],
    // Unless delivering that message failed: a new TicketRun starts the worker again and takes the message.
    [
      "a failed Ticket whose delivery of a person's answer failed",
      true,
      ticket({ ...answered, delivery: { error: "offline", at: "" }, runs: [reportedAt("failed")] }),
    ],
    ["a working Ticket whose Input could not be delivered", true, ticket({ delivery: { error: "offline", at: "" } })],
    [
      "an ended Ticket whose Input could not be delivered",
      false,
      ticket({ ended, delivery: { error: "offline", at: "" } }),
    ],
  ])("%s: %s", (_name, expected, value) => {
    expect(canRetry(value)).toBe(expected);
  });
  it("offers a retry in each person stage a new TicketRun remedies", () => {
    const delivery = ticket({ ...answered, delivery: { error: "offline", at: "" }, runs: [reportedAt("failed")] });
    expect(ticketStage(delivery)).toEqual({ stage: "person", action: "delivery" });
    expect(canRetry(delivery)).toBe(true);
  });
});
