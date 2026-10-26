import { describe, expect, it } from "vitest";
import { expectedEffectOf, triageChangesHash, validateTriageInput } from "@/domains/integrations/github-triage";

/*
 * ASH-284 proposal-shape coverage, DB-free: the review card's effect line is
 * built from coordinates and changes (never raw issue text), the dedupe hash
 * is stable per change set, and malformed triage refuses by name.
 */
describe("github triage proposal shape", () => {
  it("builds the effect line from coordinates and changes", () => {
    expect(expectedEffectOf("ashwinrachhavt", "Polymath", 42, { addLabels: ["bug"], assignees: ["ashwinrachhavt"] })).toBe(
      "On ashwinrachhavt/Polymath#42: add label bug; assign @ashwinrachhavt. Nothing is applied automatically.",
    );
    expect(expectedEffectOf("o", "r", 7, { closeReason: "not_planned" })).toBe(
      "On o/r#7: close as not planned. Nothing is applied automatically.",
    );
  });

  it("hashes the change set stably, ignoring order and duplicates", () => {
    const a = triageChangesHash({ addLabels: ["bug", "triage", "bug"] });
    const b = triageChangesHash({ addLabels: ["triage", "bug"] });
    const c = triageChangesHash({ addLabels: ["bug"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(triageChangesHash({})).not.toBe(triageChangesHash({ closeReason: "completed" }));
  });
});

describe("validateTriageInput refusals", () => {
  const base = { owner: "o", repo: "r", issueNumber: 1, issueTitle: "t", rationale: "because", changes: { addLabels: ["bug"] } };

  it("refuses malformed repository coordinates by name", () => {
    expect(() => validateTriageInput({ ...base, owner: "not/a repo" })).toThrowError(/owner and repo name/);
    expect(() => validateTriageInput({ ...base, issueNumber: 0 })).toThrowError(/positive integer/);
  });

  it("refuses an empty triage instead of inventing one", () => {
    expect(() => validateTriageInput({ ...base, changes: {} })).toThrowError(/no triage to propose/);
  });

  it("refuses labels that are both added and removed", () => {
    expect(() => validateTriageInput({ ...base, changes: { addLabels: ["bug"], removeLabels: ["bug"] } })).toThrowError(/both added and removed/);
  });

  it("refuses a close reason outside the pair GitHub supports", () => {
    expect(() => validateTriageInput({ ...base, changes: { closeReason: "wontfix" as never } })).toThrowError(/close reason/);
  });
});
