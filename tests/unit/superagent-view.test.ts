/** The stage table's port: first matching row wins, groups follow the table order, counts are lists. */
import { describe, expect, it } from "vitest";
import { mandateProcedure, superviseTickets, type TicketView } from "@/components/superagent/view";
import type { ReportState, Ticket, TicketRun } from "@/domains/superagent/core/model";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    title: "Summarize the meeting",
    decisionId: "d1",
    mandate: {
      strength: "explicit",
      policyVersion: "abc123def4567890",
      basis: { via: "addressed", addressed: "direct" },
      actor: { source: "chat", id: "u1" },
      scope: "Summarize the meeting notes.",
    },
    channels: [],
    runs: [],
    inputs: [],
    undelivered: [],
    origin: { triggerId: "tr1", triggerIds: ["tr1"] },
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

const run = (
  state: TicketRun["state"],
  report?: { state: ReportState; summary: string },
  deliveredAt?: string,
): TicketRun => ({
  id: "r1",
  state,
  createdAt: "2026-11-02T10:00:00.000Z",
  ...(report ? { report: { ...report, at: "2026-11-02T10:05:00.000Z" } } : {}),
  ...(deliveredAt ? { deliveredAt } : {}),
});

describe("superviseTickets (the ported stage table)", () => {
  it("reads the stage rows first matching row wins", () => {
    const cases: { ticket: Ticket; stageKey: TicketView["stageKey"] }[] = [
      // A delivery that keeps failing needs a person before anything else.
      {
        ticket: makeTicket({
          delivery: { error: "send failed", at: "2026-11-02T10:06:00.000Z" },
          runs: [run("running")],
        }),
        stageKey: "person-delivery",
      },
      // A held question beats a ready report: the question is older.
      {
        ticket: makeTicket({
          attention: { id: "a1", question: "Which meeting?" },
          runs: [run("ended", { state: "ready", summary: "Done." })],
        }),
        stageKey: "person-answer",
      },
      { ticket: makeTicket({ runs: [run("ended", { state: "ready", summary: "Done." })] }), stageKey: "person-review" },
      {
        ticket: makeTicket({ runs: [run("ended", { state: "blocked", summary: "Need access." })] }),
        stageKey: "person-blocked",
      },
      {
        ticket: makeTicket({ runs: [run("ended", { state: "failed", summary: "Crashed." })] }),
        stageKey: "person-failed",
      },
      // A person's message delivered after the blocked report wakes the run only when the run reports again;
      // the stage table reads the latest report, so the ticket stays person-blocked until then.
      {
        ticket: makeTicket({
          runs: [run("ended", { state: "blocked", summary: "Need access." }, "2026-11-02T10:07:00.000Z")],
        }),
        stageKey: "person-blocked",
      },
      { ticket: makeTicket({ runs: [run("pending")] }), stageKey: "working-queued" },
      { ticket: makeTicket({ runs: [run("running")] }), stageKey: "working" },
      {
        ticket: makeTicket({ runs: [run("ended", { state: "waiting", summary: "Waiting for input." })] }),
        stageKey: "idle",
      },
      {
        ticket: makeTicket({ ended: { at: "2026-11-02T10:05:00.000Z", by: "executor", outcome: "completed" } }),
        stageKey: "ended",
      },
    ];
    for (const { ticket, stageKey } of cases) {
      const groups = superviseTickets([ticket]);
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe(stageKey);
    }
  });

  it("groups follow the stage table's order and keep every ticket", () => {
    const groups = superviseTickets([
      makeTicket({ id: "a", runs: [run("running")] }),
      makeTicket({ id: "b", runs: [run("ended", { state: "ready", summary: "Done." })] }),
      makeTicket({ id: "c", ended: { at: "2026-11-02T10:05:00.000Z", by: "human", outcome: "stopped" } }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["person-review", "working", "ended"]);
    // Every ticket in a group is classified into that group: counts are lists.
    for (const group of groups) {
      expect(group.tickets.every((view) => view.stageKey === group.key)).toBe(true);
    }
  });

  it("hides empty groups instead of rendering zero counts", () => {
    expect(superviseTickets([])).toEqual([]);
  });
});

describe("mandateProcedure", () => {
  it("names the basis for an addressed explicit request", () => {
    const text = mandateProcedure(makeTicket().mandate);
    expect(text).toContain("Scope: Summarize the meeting notes.");
    expect(text).toContain("a listed sender addressing the agent, addressed by direct");
    expect(text).toContain("Strength: explicit");
  });

  it("names a bot message as an inferred candidate at most", () => {
    const text = mandateProcedure(
      makeTicket({
        mandate: {
          strength: "inferred",
          policyVersion: "abc123def4567890",
          basis: { via: "bot", addressed: "mention", observation: { mode: "observe" } },
          actor: { source: "chat", id: "ci-bot" },
          scope: "Triage the failing check.",
        },
      }).mandate,
    );
    expect(text).toContain(
      "Authorized by a listed bot's message, addressed by mention, an inferred candidate at most.",
    );
    expect(text).toContain("Strength: inferred. Policy abc123def456.");
  });
});
