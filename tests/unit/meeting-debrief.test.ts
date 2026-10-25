import { describe, expect, it } from "vitest";
import { DEBRIEF_MAX_FOLLOW_UPS, DEBRIEF_MAX_NOTES, DEBRIEF_MAX_TASKS, parseDebriefAnswer } from "@/domains/knowledge/meeting-debrief";

/*
 * The debrief's answer parsing is the trust boundary between a model and the
 * review queue: a malformed, over-cap, or padded answer is unusable as a
 * whole - never partially applied - because the owner approves what the
 * cards show, and the cards show exactly this draft.
 */

describe("parseDebriefAnswer", () => {
  it("accepts a full answer", () => {
    const draft = parseDebriefAnswer(
      JSON.stringify({
        tasks: [{ title: "Send the roadmap", description: "Priya asked for the Q3 version." }],
        notes: [{ title: "Pricing decision", markdown: "**Decided:** annual billing stays." }],
        followUps: [{ summary: "confirm the launch date", person: "Marcus" }],
      }),
    );
    expect(draft.tasks).toHaveLength(1);
    expect(draft.notes?.[0]?.markdown).toContain("annual billing");
    expect(draft.followUps?.[0]?.person).toBe("Marcus");
  });

  it("accepts nulls for an empty meeting", () => {
    const draft = parseDebriefAnswer(JSON.stringify({ tasks: null, notes: null, followUps: null }));
    expect(draft.tasks).toBeNull();
    expect(draft.notes).toBeNull();
    expect(draft.followUps).toBeNull();
  });

  it("rejects an answer that is not JSON", () => {
    expect(() => parseDebriefAnswer("not json at all")).toThrowError(/not JSON/);
  });

  it("rejects an answer missing the debrief shape", () => {
    expect(() => parseDebriefAnswer(JSON.stringify({ summary: "nice chat" }))).toThrowError(/did not match/);
  });

  it("rejects over-cap lists instead of truncating them", () => {
    const over = (n: number, item: object) => Array.from({ length: n }, () => item);
    expect(() =>
      parseDebriefAnswer(JSON.stringify({ tasks: over(DEBRIEF_MAX_TASKS + 1, { title: "x" }), notes: null, followUps: null })),
    ).toThrowError(/did not match/);
    expect(() =>
      parseDebriefAnswer(JSON.stringify({ tasks: null, notes: over(DEBRIEF_MAX_NOTES + 1, { title: "x", markdown: "y" }), followUps: null })),
    ).toThrowError(/did not match/);
    expect(() =>
      parseDebriefAnswer(
        JSON.stringify({ tasks: null, notes: null, followUps: over(DEBRIEF_MAX_FOLLOW_UPS + 1, { summary: "x" }) }),
      ),
    ).toThrowError(/did not match/);
  });

  it("rejects empty titles and bodies rather than proposing blank cards", () => {
    expect(() => parseDebriefAnswer(JSON.stringify({ tasks: [{ title: " " }], notes: null, followUps: null }))).toThrowError(
      /did not match/,
    );
    expect(() =>
      parseDebriefAnswer(JSON.stringify({ tasks: null, notes: [{ title: "Decisions", markdown: "" }], followUps: null })),
    ).toThrowError(/did not match/);
  });
});
