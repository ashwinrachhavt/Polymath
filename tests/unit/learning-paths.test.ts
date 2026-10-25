import { describe, expect, it } from "vitest";
import { parseLearningPathAnswer } from "@/domains/knowledge/learning-paths";

/*
 * The learning-path parser keeps a padded or empty model answer out of the
 * review queue: the owner approves exactly the sequence the parser accepted.
 */

describe("parseLearningPathAnswer", () => {
  it("accepts a full path", () => {
    const draft = parseLearningPathAnswer(
      JSON.stringify({
        pathTitle: "Understanding distributed consensus",
        overview: "Start with the problem, then Raft, then practice.",
        notes: [{ title: "Why consensus is hard", markdown: "Failures first." }],
        practiceTasks: [{ title: "Sketch Raft's election on paper" }],
        cards: [{ prompt: "What does a quorum prevent?", answer: "Two leaders deciding differently." }],
      }),
    );
    expect(draft.notes).toHaveLength(1);
    expect(draft.cards?.[0]?.prompt).toContain("quorum");
  });

  it("accepts partial paths - notes only, cards only", () => {
    const notesOnly = parseLearningPathAnswer(
      JSON.stringify({ pathTitle: "T", overview: "O", notes: [{ title: "A", markdown: "B" }], practiceTasks: null, cards: null }),
    );
    expect(notesOnly.practiceTasks).toBeNull();
  });

  it("rejects an empty path - there is nothing to propose", () => {
    expect(() =>
      parseLearningPathAnswer(JSON.stringify({ pathTitle: "T", overview: "O", notes: null, practiceTasks: null, cards: null })),
    ).toThrowError(/empty path/);
  });

  it("rejects non-JSON and wrong shapes", () => {
    expect(() => parseLearningPathAnswer("nope")).toThrowError(/not JSON/);
    expect(() => parseLearningPathAnswer(JSON.stringify({ goal: "X" }))).toThrowError(/did not match/);
  });
});
