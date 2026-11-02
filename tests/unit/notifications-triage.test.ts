import { describe, expect, it } from "vitest";
import { classifyRunState, runTitle, triageTab, type RunState, type TriageItem } from "@/domains/notifications/feed";

/*
 * The triage seam's pure core: which tab owns an item, and what a run card is
 * titled. The database-side classification matrix that joins questions and
 * decisions lives in tests/integration/notifications-triage-feed.test.ts —
 * this file pins the mapping itself, for every state the run enum can hold.
 */

function runItem(state: RunState): Extract<TriageItem, { kind: "run" }> {
  return {
    kind: "run",
    id: "r1",
    runId: "r1",
    runState: state,
    stateLabel: state,
    title: "t",
    detail: null,
    href: "/polymath/r1",
    at: new Date(),
  };
}

describe("classifyRunState", () => {
  it("separates working from failed from finished, for every run state", () => {
    expect(classifyRunState("queued")).toBe("active");
    expect(classifyRunState("running")).toBe("active");
    expect(classifyRunState("waiting_input")).toBe("active");
    expect(classifyRunState("waiting_approval")).toBe("active");
    expect(classifyRunState("failed")).toBe("failed");
    expect(classifyRunState("succeeded")).toBe("done");
    expect(classifyRunState("cancelled")).toBe("done");
  });
});

describe("triageTab", () => {
  it("sends questions and decisions to the Inbox", () => {
    const question: Extract<TriageItem, { kind: "question" }> = {
      kind: "question",
      id: "q1",
      runId: "r1",
      questionText: "Who is this person?",
      context: null,
      askedAt: new Date(),
      href: "/polymath/r1",
    };
    const decision: Extract<TriageItem, { kind: "decision" }> = {
      kind: "decision",
      id: "p1",
      title: "Send the introduction",
      detail: "Sends an email",
      href: "/reviews?proposal=p1",
      at: new Date(),
      decision: { decisionType: "action", revisionId: "rev1", version: 1, expired: false },
    };
    expect(triageTab(question)).toBe("inbox");
    expect(triageTab(decision)).toBe("inbox");
  });

  it("keeps working runs In-Flight, and a failed run needs the owner", () => {
    for (const state of ["queued", "running", "waiting_input", "waiting_approval"] as const) {
      expect(triageTab(runItem(state))).toBe("inFlight");
    }
    expect(triageTab(runItem("failed"))).toBe("inbox");
  });

  it("files finished runs — succeeded and cancelled — as Activity", () => {
    expect(triageTab(runItem("succeeded"))).toBe("activity");
    expect(triageTab(runItem("cancelled"))).toBe("activity");
  });
});

describe("runTitle", () => {
  it("prefers the summary the agent wrote", () => {
    expect(runTitle("Read three pages about Zettel sitting", "an objective")).toBe(
      "Read three pages about Zettel sitting",
    );
  });

  it("falls back to the objective's first line, capped at 120", () => {
    expect(runTitle(null, "First line\nsecond line")).toBe("First line");
    const long = "x".repeat(200);
    expect(runTitle(null, long)).toBe(`${"x".repeat(117)}...`);
  });

  it("caps a long summary under the same policy", () => {
    const longSummary = `${"y".repeat(130)} end`;
    expect(runTitle(longSummary, "objective")).toBe(`${"y".repeat(117)}...`);
  });

  it("treats blank summaries as absent", () => {
    expect(runTitle("   ", "Real objective")).toBe("Real objective");
  });

  it("names a known objective and an empty one", () => {
    expect(runTitle(null, "onboarding-interview v1")).toBe("Onboarding interview");
    expect(runTitle(null, "")).toBe("Agent run");
  });
});
