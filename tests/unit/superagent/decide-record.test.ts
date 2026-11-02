import { describe, expect, it } from "vitest";
import { resolveAssessmentDecision, type DecideVerdict, type EveJudgment } from "@/domains/superagent/decide/record";

/*
 * The escalation rule the assessor applies after both judgments exist: Eve's
 * acceptance plus a Decide probability at or above the threshold admits;
 * below-threshold and material disagreement record not-admitted for the panel
 * to surface. Decide's absence never blocks the pipeline.
 */

const THRESHOLD = 0.7;

const verdict = (admitProbability: number): DecideVerdict => ({
  admitProbability,
  question: "Should this trigger be admitted for autonomous work?",
  model: "mercury-decide",
});

describe("resolveAssessmentDecision", () => {
  it("admits on Eve's acceptance with a probability at or above the threshold", () => {
    const record = resolveAssessmentDecision({ outcome: "accept", rules: ["r1"] }, verdict(0.7), {
      admitThreshold: THRESHOLD,
    });
    expect(record.final).toEqual({ kind: "accept", decidedBy: "eve" });
  });

  it("escalates an Eve acceptance whose probability fell below the threshold", () => {
    const record = resolveAssessmentDecision({ outcome: "accept" }, verdict(0.6999), { admitThreshold: THRESHOLD });
    expect(record.final).toEqual({ kind: "ignore", decidedBy: "escalated", escalation: "belowThreshold" });
  });

  it("escalates material disagreement: Eve would not admit, the probability reached the threshold", () => {
    const record = resolveAssessmentDecision({ outcome: "ignore", reason: "stale thread" }, verdict(0.95), {
      admitThreshold: THRESHOLD,
    });
    expect(record.final).toEqual({ kind: "ignore", decidedBy: "escalated", escalation: "disagreement" });
  });

  it("keeps Eve's rejection below the threshold as Eve's own ignore", () => {
    const record = resolveAssessmentDecision({ outcome: "ignore" }, verdict(0.1), { admitThreshold: THRESHOLD });
    expect(record.final).toEqual({ kind: "ignore", decidedBy: "eve" });
  });

  it("lets Eve's stop stand whatever the probability said — a stop is not an admission question", () => {
    const stopped: EveJudgment = { outcome: "stop" };
    expect(resolveAssessmentDecision(stopped, verdict(0.99), { admitThreshold: THRESHOLD }).final).toEqual({
      kind: "stop",
      decidedBy: "eve",
    });
  });

  it("records unavailable when Eve could not judge — Decide alone cannot admit", () => {
    const record = resolveAssessmentDecision({ outcome: "unavailable" }, verdict(0.99), { admitThreshold: THRESHOLD });
    expect(record.final).toEqual({ kind: "unavailable", decidedBy: "eve" });
  });

  it("lets Eve decide when the seam did not run, and shows the absence in the record", () => {
    const record = resolveAssessmentDecision({ outcome: "accept" }, null, { admitThreshold: THRESHOLD });
    expect(record.decide).toBeNull();
    expect(record.final).toEqual({ kind: "accept", decidedBy: "eve" });
  });
});
