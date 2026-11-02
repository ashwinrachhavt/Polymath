import { describe, expect, it } from "vitest";
import { MIN_QUIZ_QUESTIONS, MAX_QUIZ_QUESTIONS, verifyQuiz } from "@/domains/learning/generate-quiz";
import type { GeneratedQuestion } from "@/integrations/learning/quiz-generator";

/*
 * The quiz generator's trust boundary: the model proposes questions with
 * verbatim evidence quotes, the domain keeps only questions whose quote is
 * a verbatim passage of the source text and whose answer names a real
 * choice value. Anything else is dropped and counted, never repaired.
 */

const TEXT = "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days. The deposit is held in escrow.";

function question(overrides: Partial<GeneratedQuestion> & { quote: string }): GeneratedQuestion {
  return {
    prompt: "What happens to rent?",
    choices: [
      { value: "rises", label: "Rent rises by 4% unless notice is given within 60 days." },
      { value: "falls", label: "Rent falls by 4% unless notice is given within 60 days." },
    ],
    answerValue: "rises",
    explanation: "The lease states a 4% rise absent notice.",
    ...overrides,
  };
}

describe("verifyQuiz", () => {
  it("keeps a proven question and records the exact span of its evidence", () => {
    const quote = "Rent rises by 4% unless the tenant gives notice within 60 days.";
    const out = verifyQuiz(TEXT, [question({ quote })]);
    expect(out.droppedQuestions).toBe(0);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].evidence).toEqual({ quote, startOffset: TEXT.indexOf(quote), endOffset: TEXT.indexOf(quote) + quote.length });
  });

  it("drops a paraphrased quote - the evidence must be verbatim", () => {
    const out = verifyQuiz(TEXT, [question({ quote: "Rent goes up 4 percent" })]);
    expect(out.questions).toHaveLength(0);
    expect(out.droppedQuestions).toBe(1);
  });

  it("drops a question whose answerValue names no choice value", () => {
    const out = verifyQuiz(TEXT, [question({ quote: "The deposit is held in escrow.", answerValue: "nonexistent" })]);
    expect(out.questions).toHaveLength(0);
    expect(out.droppedQuestions).toBe(1);
  });

  it("drops questions with duplicate choice values, empty explanations, or empty prompts", () => {
    const duplicateValues = question({
      quote: "The deposit is held in escrow.",
      choices: [
        { value: "same", label: "One." },
        { value: "same", label: "Two." },
      ],
    });
    const noExplanation = question({ quote: "The deposit is held in escrow.", explanation: "   " });
    const noPrompt = question({ quote: "The deposit is held in escrow.", prompt: "" });
    const out = verifyQuiz(TEXT, [duplicateValues, noExplanation, noPrompt]);
    expect(out.questions).toHaveLength(0);
    expect(out.droppedQuestions).toBe(3);
  });

  it("caps the quiz at the maximum question count", () => {
    const quote = "The deposit is held in escrow.";
    const out = verifyQuiz(TEXT, Array.from({ length: 9 }, (_, i) => question({ quote, prompt: `Question ${i}?` })));
    expect(out.questions).toHaveLength(MAX_QUIZ_QUESTIONS);
  });

  it("keeps every verbatim substring as evidence with its exact span, and drops single-character mutations (fuzz)", () => {
    // Deterministic LCG so a failure is reproducible from the seed.
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 40; i++) {
      const start = Math.floor(next() * (TEXT.length - 45));
      const end = start + 10 + Math.floor(next() * 30);
      const quote = TEXT.slice(start, end);
      if (/^\s|\s$/.test(quote)) continue; // boundary whitespace trims; the contract test below covers it
      const out = verifyQuiz(TEXT, [question({ quote, prompt: `Q${i}` })]);
      expect(out.droppedQuestions).toBe(0);
      expect(out.questions[0].evidence).toEqual({ quote, startOffset: start, endOffset: end });
      expect(TEXT.slice(out.questions[0].evidence.startOffset, out.questions[0].evidence.endOffset)).toBe(out.questions[0].evidence.quote);
    }
    const mutated = `X${TEXT.slice(1, 30)}`;
    expect(verifyQuiz(TEXT, [question({ quote: mutated })]).droppedQuestions).toBe(1);
  });

  it("records the located span when the model's quote carries boundary whitespace", () => {
    const padded = `  ${TEXT.slice(30, 80)}  `;
    const out = verifyQuiz(TEXT, [question({ quote: padded })]);
    expect(out.droppedQuestions).toBe(0);
    const evidence = out.questions[0].evidence;
    expect(TEXT.slice(evidence.startOffset, evidence.endOffset)).toBe(evidence.quote);
    expect(evidence.quote).toBe(TEXT.slice(30, 80));
  });

  it("trims an oversized quote and keeps the offsets describing the stored quote", () => {
    const longText = "A ".repeat(300) + "The lease ends when the tenant dies.";
    const longQuote = longText.slice(0, 500);
    const out = verifyQuiz(longText, [question({ quote: longQuote })]);
    expect(out.droppedQuestions).toBe(0);
    const evidence = out.questions[0].evidence;
    expect(evidence.quote.length).toBeLessThanOrEqual(400);
    expect(longText.slice(evidence.startOffset, evidence.endOffset)).toBe(evidence.quote);
  });

  it("drops a question whose distinct choice values would collide after the value cap", () => {
    const prefix = "v".repeat(60);
    const colliding = question({
      quote: "The deposit is held in escrow.",
      choices: [
        { value: `${prefix}one`, label: "One." },
        { value: `${prefix}two`, label: "Two." },
      ],
      answerValue: `${prefix}one`,
    });
    expect(verifyQuiz(TEXT, [colliding]).droppedQuestions).toBe(1);
    const atCap = question({
      quote: "The deposit is held in escrow.",
      choices: [
        { value: prefix, label: "One." },
        { value: "falls", label: "Two." },
      ],
      answerValue: prefix,
    });
    const out = verifyQuiz(TEXT, [atCap]);
    expect(out.droppedQuestions).toBe(0);
    expect(out.questions[0].choices[0].value).toBe(prefix);
  });

  it("exposes the minimum count the domain enforces", () => {
    expect(MIN_QUIZ_QUESTIONS).toBe(3);
  });
});
