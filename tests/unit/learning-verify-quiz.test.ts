import { describe, expect, it } from "vitest";
import { MIN_QUIZ_QUESTIONS, MAX_QUIZ_QUESTIONS, verifyQuiz } from "@/domains/learning/generate-quiz";
import { locateQuoteNormalized } from "@/domains/learning/locate-quote";
import type { GeneratedQuestion } from "@/integrations/learning/quiz-generator";

/*
 * The quiz generator's trust boundary: the model proposes questions with
 * verbatim evidence quotes, the domain keeps only questions whose quote is
 * a verbatim passage of the source text and whose answer names a real
 * choice value. Anything else is dropped and counted, never repaired.
 */

const TEXT =
  "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days. The deposit is held in escrow.";

// Real extraction text is markdown: wiki links, citation refs, image
// embeds. The model quotes the prose a reader sees; matching must
// tolerate the formatting without tolerating paraphrase.
const WIKI = `Hermann Ebbinghaus

[![](https://thumb.wikimedia.org/x.jpg)Portrait](https://en.wikipedia.org/wiki/X)

In 1894, he was passed over for promotion to head of the philosophy department at [Berlin](https://en.wikipedia.org/wiki/University_of_Berlin "University of Berlin"), most likely due to his lack of publications. Shortly after this publication, on 26 February 1909,[\\[2\\]](#cite_note-1968-2) Ebbinghaus died from [pneumonia](https://en.wikipedia.org/wiki/Pneumonia).`;

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
    expect(out.questions[0].evidence).toEqual({
      quote,
      startOffset: TEXT.indexOf(quote),
      endOffset: TEXT.indexOf(quote) + quote.length,
    });
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
    const out = verifyQuiz(
      TEXT,
      Array.from({ length: 9 }, (_, i) => question({ quote, prompt: `Question ${i}?` })),
    );
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
      expect(TEXT.slice(out.questions[0].evidence.startOffset, out.questions[0].evidence.endOffset)).toBe(
        out.questions[0].evidence.quote,
      );
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
    // The stored quote's normalized form is exactly what the offsets cut.
    const raw = longText.slice(evidence.startOffset, evidence.endOffset);
    expect(raw.replace(/\s+/g, " ").trim()).toBe(evidence.quote.replace(/\s+/g, " ").trim());
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

  it("drops a question whose distinct labels would collide after the label cap", () => {
    const prefix = "L".repeat(200);
    const colliding = question({
      quote: "The deposit is held in escrow.",
      choices: [
        { value: "rises", label: `${prefix}one` },
        { value: "falls", label: `${prefix}two` },
      ],
    });
    expect(verifyQuiz(TEXT, [colliding]).droppedQuestions).toBe(1);
    const atCap = question({
      quote: "The deposit is held in escrow.",
      choices: [
        { value: "rises", label: prefix },
        { value: "falls", label: "Rent falls by 4%." },
      ],
    });
    const out = verifyQuiz(TEXT, [atCap]);
    expect(out.droppedQuestions).toBe(0);
    expect(out.questions[0].choices[0].label).toBe(prefix);
  });

  it("exposes the minimum count the domain enforces", () => {
    expect(MIN_QUIZ_QUESTIONS).toBe(3);
  });
});

describe("locateQuoteNormalized", () => {
  it("locates a quote that crosses a markdown link, mapping back to original offsets", () => {
    const quote =
      "In 1894, he was passed over for promotion to head of the philosophy department at Berlin, most likely due to his lack of publications.";
    const span = locateQuoteNormalized(WIKI, quote);
    expect(span).not.toBeNull();
    const raw = WIKI.slice(span!.start, span!.end);
    // The raw bytes carry the link syntax; normalized equality is the
    // locator's guarantee (asserted by the paraphrase and plain-text tests).
    expect(raw).toContain("[Berlin](https://en.wikipedia.org/wiki/University_of_Berlin");
    expect(raw.startsWith("In 1894, he was passed over")).toBe(true);
    expect(raw.endsWith("lack of publications.")).toBe(true);
  });

  it("locates a quote that crosses a citation ref", () => {
    const span = locateQuoteNormalized(
      WIKI,
      "Shortly after this publication, on 26 February 1909, Ebbinghaus died from pneumonia",
    );
    expect(span).not.toBeNull();
  });

  it("collapses whitespace runs so a quote copied across paragraphs locates", () => {
    const span = locateQuoteNormalized(WIKI, "Hermann Ebbinghaus Portrait");
    expect(span).not.toBeNull();
    expect(WIKI.slice(span!.start, span!.end).startsWith("Hermann Ebbinghaus")).toBe(true);
  });

  it("still rejects paraphrase - formatting tolerance is not paraphrase tolerance", () => {
    expect(locateQuoteNormalized(WIKI, "In 1894, he was denied a promotion in Berlin")).toBeNull();
    expect(locateQuoteNormalized(WIKI, "He invented the forgetting curve in Berlin")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(locateQuoteNormalized(WIKI, "   ")).toBeNull();
  });

  it("keeps byte-exact matching working on plain text", () => {
    const span = locateQuoteNormalized(TEXT, "The deposit is held in escrow.");
    expect(span).toEqual({
      start: TEXT.indexOf("The deposit is held in escrow."),
      end: TEXT.indexOf("The deposit is held in escrow.") + "The deposit is held in escrow.".length,
    });
  });
});

describe("verifyQuiz with normalized evidence", () => {
  it("keeps a question whose quote crosses markdown links, with offsets into the raw text", () => {
    const quote =
      "In 1894, he was passed over for promotion to head of the philosophy department at Berlin, most likely due to his lack of publications.";
    const out = verifyQuiz(WIKI, [question({ quote })]);
    expect(out.droppedQuestions).toBe(0);
    expect(out.questions).toHaveLength(1);
    const { startOffset, endOffset } = out.questions[0].evidence;
    expect(startOffset).toBeGreaterThanOrEqual(0);
    expect(endOffset).toBeGreaterThan(startOffset);
    expect(endOffset).toBeLessThanOrEqual(WIKI.length);
  });

  it("drops a question whose quote is not in the document at all", () => {
    const out = verifyQuiz(WIKI, [question({ quote: "Ebbinghaus moved to Paris in 1895 and never returned." })]);
    expect(out.droppedQuestions).toBe(1);
    expect(out.questions).toHaveLength(0);
  });
});
