import { describe, expect, it } from "vitest";
import {
  BRIEF_MAX_LIST_ITEMS,
  BRIEFABLE_KINDS,
  parseDesignBriefAnswer,
  renderBriefMarkdown,
  type DesignBrief,
} from "@/domains/knowledge/design-brief";

/*
 * The brief parser is the trust boundary between a model and the Library: a
 * malformed, over-cap, or padded answer is unusable as a whole - never
 * partially applied - because the saved brief is what the owner reviews and
 * what a later Canva handoff would carry verbatim.
 */

const FULL: DesignBrief = {
  title: "Launch one-pager",
  objective: "Explain the pricing change to existing customers.",
  audience: "Current platform-tier customers.",
  keyMessage: "Annual billing stays.",
  tone: ["plain", "confident"],
  format: "doc",
  visualDirection: "Single column, generous whitespace, one comparison table.",
  deliverables: ["One-page doc"],
  constraints: ["Ship before the renewal email"],
  callToAction: "Read the migration guide",
};

describe("parseDesignBriefAnswer", () => {
  it("accepts a full answer", () => {
    const brief = parseDesignBriefAnswer(JSON.stringify(FULL));
    expect(brief.format).toBe("doc");
    expect(brief.tone).toEqual(["plain", "confident"]);
  });

  it("accepts nulls for fields the card does not support", () => {
    const brief = parseDesignBriefAnswer(JSON.stringify({ ...FULL, deliverables: null, constraints: null, callToAction: null }));
    expect(brief.deliverables).toBeNull();
    expect(brief.callToAction).toBeNull();
  });

  it("rejects an answer that is not JSON", () => {
    expect(() => parseDesignBriefAnswer("not json")).toThrowError(/not JSON/);
  });

  it("rejects an answer missing the brief shape", () => {
    expect(() => parseDesignBriefAnswer(JSON.stringify({ summary: "nice research" }))).toThrowError(/did not match/);
  });

  it("rejects a format outside Canva's presets", () => {
    expect(() => parseDesignBriefAnswer(JSON.stringify({ ...FULL, format: "billboard" }))).toThrowError(/did not match/);
  });

  it("rejects over-cap lists instead of truncating them", () => {
    const over = Array.from({ length: BRIEF_MAX_LIST_ITEMS + 1 }, () => "x");
    expect(() => parseDesignBriefAnswer(JSON.stringify({ ...FULL, tone: over }))).toThrowError(/did not match/);
    expect(() => parseDesignBriefAnswer(JSON.stringify({ ...FULL, deliverables: over }))).toThrowError(/did not match/);
  });

  it("rejects empty required fields rather than saving a hollow brief", () => {
    expect(() => parseDesignBriefAnswer(JSON.stringify({ ...FULL, objective: " " }))).toThrowError(/did not match/);
    expect(() => parseDesignBriefAnswer(JSON.stringify({ ...FULL, tone: [] }))).toThrowError(/did not match/);
  });
});

describe("renderBriefMarkdown", () => {
  it("renders every field and names the source", () => {
    const md = renderBriefMarkdown(FULL, "Acme case study");
    expect(md).toContain("# Launch one-pager");
    expect(md).toContain('from "Acme case study"');
    expect(md).toContain("**Key message.** Annual billing stays.");
    expect(md).toContain("- Ship before the renewal email");
  });

  it("shows unset fields as absent, never smoothed over", () => {
    const md = renderBriefMarkdown({ ...FULL, deliverables: null, constraints: null, callToAction: null }, "S");
    expect(md).toContain("- None given.");
    expect(md).toContain("**Call to action.** None given.");
  });

  it("states the handoff boundary in the artifact itself", () => {
    const md = renderBriefMarkdown(FULL, "S");
    expect(md).toContain("Canva handoff is not available yet");
  });
});

describe("BRIEFABLE_KINDS", () => {
  it("covers the textual research surfaces and excludes designed output", () => {
    expect(BRIEFABLE_KINDS).toContain("report");
    expect(BRIEFABLE_KINDS).toContain("zettel");
    expect(BRIEFABLE_KINDS).not.toContain("transcript");
    expect(BRIEFABLE_KINDS).not.toContain("deck");
    expect(BRIEFABLE_KINDS).not.toContain("infographic");
  });
});
