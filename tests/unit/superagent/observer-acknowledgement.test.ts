import { describe, expect, it, vi } from "vitest";

/*
 * The observer's acknowledgement rule.
 *
 * The bug this pins: the observer wrote its "already observed" marker even
 * when turnEnded/report/reply threw. An exception before the reply was queued
 * therefore marked the turn done, the next pass skipped it, and the person
 * waited on "Working" while the answer sat in the timeline unreported. An
 * acknowledgement may only advance when the state and the outgoing reply
 * actually committed.
 */

vi.mock("@/lib/db", () => ({ db: {} }));

const { reportTerminalRun, domainMovedOn } = await import("@/domains/superagent/wiring");

type Host = Parameters<typeof reportTerminalRun>[0];

/** A host whose engine records each call and can be made to throw on one. */
function hostThatThrows(at: "turnEnded" | "report" | "reply" | null, error?: unknown) {
  const calls: string[] = [];
  const maybeThrow = (name: "turnEnded" | "report" | "reply") => {
    calls.push(name);
    if (name === at) throw error;
  };
  const host = {
    engine: {
      turnEnded: () => maybeThrow("turnEnded"),
      report: () => maybeThrow("report"),
      reply: () => maybeThrow("reply"),
    },
  } as unknown as Host;
  return { host, calls };
}

const ready = { state: "ready", summary: "the answer" } as const;

describe("reportTerminalRun", () => {
  it("acknowledges a run that reported and replied", async () => {
    const { host, calls } = hostThatThrows(null);
    const moved = await reportTerminalRun(host, "ticket-1", "run-1", ready);
    expect(moved).toBe(true);
    expect(calls).toEqual(["turnEnded", "report", "reply"]);
  });

  /*
   * This is the P0: a transient failure before the reply is queued must NOT
   * acknowledge, or the result is lost for good.
   */
  it("does not acknowledge when the report throws for a transient reason", async () => {
    const { host } = hostThatThrows("report", new Error("connection reset"));
    const moved = await reportTerminalRun(host, "ticket-1", "run-1", ready);
    expect(moved).toBe(false);
  });

  it("does not acknowledge when queueing the reply throws", async () => {
    const { host } = hostThatThrows("reply", new Error("deadlock detected"));
    const moved = await reportTerminalRun(host, "ticket-1", "run-1", ready);
    expect(moved).toBe(false);
  });

  /*
   * A refusal because the domain already left the state is not a failure to
   * retry: the ticket ended or a newer run took over, and nothing is left to
   * deliver. Acknowledging is correct there.
   */
  it("acknowledges when the domain already moved on", async () => {
    const { UserError } = await import("@/domains/superagent/core/errors");
    const { host } = hostThatThrows("report", new UserError("ticketEnded"));
    const moved = await reportTerminalRun(host, "ticket-1", "run-1", ready);
    expect(moved).toBe(true);
  });
});

describe("domainMovedOn", () => {
  it("recognises the terminal refusals", async () => {
    const { UserError } = await import("@/domains/superagent/core/errors");
    expect(domainMovedOn(new UserError("ticketEnded"))).toBe(true);
    expect(domainMovedOn(new UserError("assignmentEnded"))).toBe(true);
    expect(domainMovedOn(new UserError("unknownTicket"))).toBe(true);
  });

  it("treats a validation refusal and a plain error as retryable", async () => {
    const { UserError } = await import("@/domains/superagent/core/errors");
    expect(domainMovedOn(new UserError("notReady"))).toBe(false);
    expect(domainMovedOn(new Error("connection reset"))).toBe(false);
    expect(domainMovedOn(undefined)).toBe(false);
  });
});
