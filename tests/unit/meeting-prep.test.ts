import { describe, expect, it } from "vitest";
import { parseMeetingPrepAnswer, PREP_MAX_TALKING_POINTS } from "@/domains/knowledge/meeting-prep";

/*
 * The prep answer parser is the trust boundary between the model and the
 * report artifact: an unusable answer must never become a half-written
 * report the owner mistakes for grounded prep.
 */

describe("parseMeetingPrepAnswer", () => {
  it("accepts a full answer", () => {
    const draft = parseMeetingPrepAnswer(
      JSON.stringify({
        summary: "Quarterly review with Priya; pricing is the open question.",
        attendeeBriefs: [{ name: "Priya Nair", brief: "Owns platform pricing; last met in September." }],
        history: "The September notes record the annual-billing decision.",
        openLoops: "The Q3 roadmap is still owed to her.",
        talkingPoints: ["Confirm the launch date", "Walk through the Q3 roadmap"],
      }),
    );
    expect(draft.talkingPoints).toHaveLength(2);
    expect(draft.attendeeBriefs?.[0]?.name).toBe("Priya Nair");
  });

  it("accepts null optional sections", () => {
    const draft = parseMeetingPrepAnswer(
      JSON.stringify({ summary: "First touch with this group.", attendeeBriefs: null, history: null, openLoops: null, talkingPoints: ["Introduce the roadmap"] }),
    );
    expect(draft.history).toBeNull();
  });

  it("rejects an answer with no talking points - the report's purpose", () => {
    expect(() =>
      parseMeetingPrepAnswer(JSON.stringify({ summary: "A meeting.", attendeeBriefs: null, history: null, openLoops: null, talkingPoints: [] })),
    ).toThrowError(/did not match/);
  });

  it("rejects non-JSON and wrong shapes", () => {
    expect(() => parseMeetingPrepAnswer("sure, here you go")).toThrowError(/not JSON/);
    expect(() => parseMeetingPrepAnswer(JSON.stringify({ report: "..." }))).toThrowError(/did not match/);
  });

  it("rejects over-cap talking points instead of truncating them", () => {
    const points = Array.from({ length: PREP_MAX_TALKING_POINTS + 1 }, (_, i) => `Point ${i}`);
    expect(() =>
      parseMeetingPrepAnswer(JSON.stringify({ summary: "A meeting.", attendeeBriefs: null, history: null, openLoops: null, talkingPoints: points })),
    ).toThrowError(/did not match/);
  });
});
