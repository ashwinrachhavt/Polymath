import { describe, expect, it } from "vitest";
import {
  DOMAIN_MIN_TOP_PROBABILITY,
  PROJECT_YES,
  TRIAGE_NO,
  TRIAGE_YES,
  triageCapture,
  type CaptureTriageAnswers,
} from "@/domains/capture/jev-classify";

/*
 * The ASH-272 truth table, row by row, including the threshold boundaries.
 * The thresholds are the contract: a probability of 0.69 vs 0.71 decides the
 * proposal kind, so the boundary values are tested explicitly.
 */

const base: CaptureTriageAnswers = {
  commitment: 0,
  contact: 0,
  reference: 0,
  worthless: 0,
  project: 0,
  domain: null,
};

describe("triageCapture truth table", () => {
  it("commitment >= 0.7 proposes a task with the gating probability as rationale", () => {
    const t = triageCapture({ ...base, commitment: 0.86, domain: { choice: "finance", topProbability: 0.9 } });
    expect(t.proposals).toHaveLength(1);
    expect(t.proposals[0].kind).toBe("task");
    expect(t.proposals[0].confidence).toBe("0.86");
    expect(t.proposals[0].rationale).toContain("commitment 0.86");
    expect(t.proposals[0].rationale).toContain("domain finance");
    expect(t.proposals[0].payload).toEqual({});
    expect(t.domainSlug).toBe("finance");
  });

  it("commitment boundary: 0.69 does not propose a task, 0.70 does", () => {
    expect(triageCapture({ ...base, commitment: 0.69 }).proposals[0].kind).not.toBe("task");
    expect(triageCapture({ ...base, commitment: 0.7 }).proposals[0].kind).toBe("task");
  });

  it("project >= 0.8 with commitment proposes a task with a project hint", () => {
    const t = triageCapture({ ...base, commitment: 0.9, project: 0.85 });
    expect(t.proposals[0].kind).toBe("task");
    expect(t.proposals[0].payload).toEqual({ projectHint: true });
    expect(t.proposals[0].rationale).toContain("project 0.85");
  });

  it("project boundary: 0.79 leaves no hint, 0.80 adds one", () => {
    expect(triageCapture({ ...base, commitment: 0.9, project: 0.79 }).proposals[0].payload).toEqual({});
    expect(triageCapture({ ...base, commitment: 0.9, project: 0.8 }).proposals[0].payload).toEqual({ projectHint: true });
  });

  it("contact >= 0.7 without commitment proposes a contact", () => {
    const t = triageCapture({ ...base, contact: 0.92 });
    expect(t.proposals[0].kind).toBe("contact");
    expect(t.proposals[0].confidence).toBe("0.92");
  });

  it("commitment wins over contact when both clear the bar", () => {
    const t = triageCapture({ ...base, commitment: 0.8, contact: 0.9 });
    expect(t.proposals[0].kind).toBe("task");
  });

  it("worthless >= 0.7 with commitment and contact low proposes discard - a proposal, never an auto-discard", () => {
    const t = triageCapture({ ...base, worthless: 0.95 });
    expect(t.proposals[0].kind).toBe("discard");
    expect(t.proposals[0].confidence).toBe("0.95");
  });

  it("project >= 0.8 without commitment proposes a note with a project hint", () => {
    const t = triageCapture({ ...base, project: 0.83, reference: 0.1 });
    expect(t.proposals[0].kind).toBe("note");
    expect(t.proposals[0].payload).toEqual({ projectHint: true });
    expect(t.proposals[0].confidence).toBe("0.83");
  });

  it("reference >= 0.7 alone proposes a note", () => {
    const t = triageCapture({ ...base, reference: 0.74 });
    expect(t.proposals[0].kind).toBe("note");
    expect(t.proposals[0].payload).toEqual({});
    expect(t.proposals[0].confidence).toBe("0.74");
  });

  it("every judgment in the 0.3-0.7 band produces a note with confidence low, flagged for review", () => {
    const t = triageCapture({ ...base, commitment: 0.5, contact: 0.4, reference: 0.6, worthless: 0.35, project: 0.5 });
    expect(t.proposals[0].kind).toBe("note");
    expect(t.proposals[0].confidence).toBe("low");
    expect(t.proposals[0].payload).toEqual({ review: true });
    expect(t.proposals[0].rationale).toContain("uncertain");
  });

  it("band boundary: exactly 0.3 and exactly 0.7 are not in the band", () => {
    // 0.3 is "no" (not band); with everything else 0 this is the all-no default.
    const atNo = triageCapture({ ...base, commitment: 0.3 });
    expect(atNo.proposals[0].kind).toBe("note");
    expect(atNo.proposals[0].rationale).toContain("no judgment cleared");
  });

  it("all judgments below 0.3 still files a reviewable note, never silence", () => {
    const t = triageCapture(base);
    expect(t.proposals[0].kind).toBe("note");
    expect(t.proposals[0].confidence).toBe("low");
    expect(t.proposals[0].payload).toEqual({ review: true });
  });

  it("a domain Choice under 0.5 top probability leaves the domain null", () => {
    const t = triageCapture({ ...base, commitment: 0.9, domain: { choice: "ai", topProbability: 0.49 } });
    expect(t.domainSlug).toBeNull();
    expect(t.proposals[0].rationale).not.toContain("domain ai");
  });

  it("domain boundary: exactly 0.5 keeps the slug", () => {
    const t = triageCapture({ ...base, commitment: 0.9, domain: { choice: "ai", topProbability: 0.5 } });
    expect(t.domainSlug).toBe("ai");
  });
});

describe("threshold constants", () => {
  it("match the spec's documented values", () => {
    expect(TRIAGE_YES).toBe(0.7);
    expect(TRIAGE_NO).toBe(0.3);
    expect(PROJECT_YES).toBe(0.8);
    expect(DOMAIN_MIN_TOP_PROBABILITY).toBe(0.5);
  });
});
