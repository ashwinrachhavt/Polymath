import { describe, expect, it } from "vitest";
import { MAX_QUESTIONS_PER_SOURCE, verifyCandidates, locateQuote, type QuizCandidate } from "@/integrations/quiz/generator";

const TEXT = `Spaced repetition schedules a review just before a memory would fade.
The ease factor controls how fast an interval grows, and it has a floor.
A card answered incorrectly restarts its interval at one day.`;

function candidate(overrides: Partial<QuizCandidate> = {}): QuizCandidate {
  return {
    prompt: "What restarts a card's interval?",
    options: ["A correct answer", "An incorrect answer", "A skipped review", "A new deck"],
    answerIndex: 1,
    explanation: "An incorrect answer resets the interval to one day.",
    quote: "A card answered incorrectly restarts its interval at one day.",
    ...overrides,
  };
}

describe("locateQuote", () => {
  it("finds a verbatim passage", () => {
    expect(locateQuote(TEXT, "The ease factor controls how fast an interval grows")).not.toBeNull();
  });

  it("rejects a quote that is not in the text", () => {
    expect(locateQuote(TEXT, "The ease factor is ignored entirely")).toBeNull();
  });

  it("rejects a quote too short to be evidence", () => {
    expect(locateQuote(TEXT, "ease")).toBeNull();
  });
});

describe("verifyCandidates", () => {
  it("keeps a candidate whose quote is verbatim", () => {
    const kept = verifyCandidates(TEXT, [candidate()]);
    expect(kept).toHaveLength(1);
    expect(kept[0].start).toBe(TEXT.indexOf("A card answered incorrectly"));
  });

  it("drops a candidate whose quote the source does not contain", () => {
    const kept = verifyCandidates(TEXT, [candidate({ quote: "An invented passage that never appears." })]);
    expect(kept).toHaveLength(0);
  });

  it("drops a question without exactly four options", () => {
    const kept = verifyCandidates(TEXT, [
      candidate({ options: ["A", "B", "C"] as unknown as [string, string, string, string] }),
    ]);
    expect(kept).toHaveLength(0);
  });

  it("drops a question with duplicate options", () => {
    const kept = verifyCandidates(TEXT, [candidate({ options: ["Same", "Same", "C", "D"] })]);
    expect(kept).toHaveLength(0);
  });

  it("drops a question whose answer index is out of range", () => {
    expect(verifyCandidates(TEXT, [candidate({ answerIndex: 4 })])).toHaveLength(0);
    expect(verifyCandidates(TEXT, [candidate({ answerIndex: -1 })])).toHaveLength(0);
  });

  it("drops a question with no explanation", () => {
    expect(verifyCandidates(TEXT, [candidate({ explanation: "  " })])).toHaveLength(0);
  });

  it("caps the number returned", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      candidate({ prompt: `Question ${i}`, quote: "Spaced repetition schedules a review just before a memory would fade." }),
    );
    expect(verifyCandidates(TEXT, many)).toHaveLength(MAX_QUESTIONS_PER_SOURCE);
  });

  it("accepts an empty candidate list without throwing", () => {
    expect(verifyCandidates(TEXT, [])).toEqual([]);
  });
});
