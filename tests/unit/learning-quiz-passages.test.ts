import { describe, expect, it } from "vitest";
import { buildQuizPassages } from "@/domains/learning/quiz-passages";
import type { QuizEvidence } from "@/domains/learning/schema";

/*
 * Read-first quizzes show a short passage of the source before the questions
 * about it. The passage is cut from the extraction text around each
 * question's located quote.
 *
 * Value: protects=every placeable question is read before it is asked, from
 * text that holds its quote and starts and ends on a sentence; fails_when=a
 * question is dropped or repeated, a body cuts mid-sentence or runs past the
 * cap, a bad offset throws or invents a passage, or ids change between runs;
 * seam=the pure builder; no_claim=loading the texts (getQuizForSitting) and
 * the runner screens (tests/unit/quiz-runner-read-first.test.tsx).
 */

const MAIN = "extraction-main";
const OTHER = "extraction-other";

/** A long article with no newlines at all, the shape web extractions take. */
const sentences = Array.from(
  { length: 120 },
  (_, n) => `Sentence ${n} explains the fact numbered ${n} in plain words.`,
);
const ARTICLE = sentences.join(" ");

function at(text: string, quote: string, extractionId?: string): QuizEvidence {
  const startOffset = text.indexOf(quote);
  if (startOffset < 0) throw new Error(`quote not in text: ${quote}`);
  return {
    quote,
    startOffset,
    endOffset: startOffset + quote.length,
    ...(extractionId ? { source: { documentId: `doc-${extractionId}`, extractionId, title: extractionId } } : {}),
  };
}

function question(id: string, ordinal: number, evidence: QuizEvidence) {
  return { id, ordinal, evidence };
}

const sources = new Map([
  [MAIN, { title: "Main article", text: ARTICLE }],
  [OTHER, { title: "Other article", text: "Short other text. It has a second fact about otters. And a third." }],
]);

function startsOnSentence(text: string, body: string): boolean {
  const start = text.indexOf(body);
  return start === 0 || /[.!?]\s$/.test(text.slice(start - 2, start));
}

function endsOnSentence(text: string, body: string): boolean {
  const end = text.indexOf(body) + body.length;
  return end === text.length || /[.!?]$/.test(body);
}

describe("buildQuizPassages", () => {
  it("gives each distant question its own passage, holding its quote and cut on sentences", () => {
    const quotes = ["fact numbered 30", "fact numbered 80", "fact numbered 110"];
    const questions = quotes.map((quote, n) => question(`q${n + 1}`, n + 1, at(ARTICLE, quote)));

    const passages = buildQuizPassages(questions, sources, MAIN);

    expect(passages.map((p) => p.questionIds)).toEqual([["q1"], ["q2"], ["q3"]]);
    passages.forEach((passage, n) => {
      expect(passage.sourceTitle).toBe("Main article");
      expect(passage.body).toContain(quotes[n]);
      expect(ARTICLE).toContain(passage.body);
      expect(startsOnSentence(ARTICLE, passage.body)).toBe(true);
      expect(endsOnSentence(ARTICLE, passage.body)).toBe(true);
      expect(passage.body.length).toBeGreaterThanOrEqual(400);
      expect(passage.body.length).toBeLessThanOrEqual(1200);
    });
  });

  it("puts two nearby quotes in one passage, ids in ordinal order", () => {
    const passages = buildQuizPassages(
      [question("late", 2, at(ARTICLE, "fact numbered 41")), question("early", 1, at(ARTICLE, "fact numbered 43"))],
      sources,
      MAIN,
    );

    expect(passages).toHaveLength(1);
    expect(passages[0].questionIds).toEqual(["early", "late"]);
    expect(passages[0].body).toContain("fact numbered 41");
    expect(passages[0].body).toContain("fact numbered 43");
  });

  it("reads each question's own source, ordering sources by their first question", () => {
    const otherText = sources.get(OTHER)!.text;
    const passages = buildQuizPassages(
      [
        question("main", 2, at(ARTICLE, "fact numbered 5", MAIN)),
        question("otter", 1, at(otherText, "a second fact about otters", OTHER)),
      ],
      sources,
      MAIN,
    );

    expect(passages.map((p) => [p.sourceTitle, p.questionIds])).toEqual([
      ["Other article", ["otter"]],
      ["Main article", ["main"]],
    ]);
    // A short source is the whole passage: there is nothing more to widen into.
    expect(passages[0].body).toBe(otherText);
  });

  it("leaves out a question whose evidence cannot be placed", () => {
    const good = at(ARTICLE, "fact numbered 60");
    const passages = buildQuizPassages(
      [
        question("past-end", 1, { quote: "x", startOffset: ARTICLE.length, endOffset: ARTICLE.length + 5 }),
        question("negative", 2, { quote: "x", startOffset: -3, endOffset: 4 }),
        question("empty", 3, { quote: "", startOffset: 10, endOffset: 10 }),
        question("missing-source", 4, { ...good, source: { documentId: "d", extractionId: "gone", title: "Gone" } }),
        question("good", 5, good),
      ],
      sources,
      MAIN,
    );

    expect(passages.flatMap((p) => p.questionIds)).toEqual(["good"]);
  });

  it("keeps a quote longer than the cap whole, widened only to its sentences", () => {
    const long = sentences.slice(10, 40).join(" ");
    const quote = long.slice(20, long.length - 20);
    const passages = buildQuizPassages([question("q", 1, at(ARTICLE, quote))], sources, MAIN);

    expect(passages).toHaveLength(1);
    expect(passages[0].body).toBe(long);
  });

  it("never cuts a word when a text has no sentence ends", () => {
    const words = Array.from({ length: 600 }, (_, n) => `word${n}`).join(" ");
    const passages = buildQuizPassages(
      [question("q", 1, at(words, "word300 word301"))],
      new Map([[MAIN, { title: "Words", text: words }]]),
      MAIN,
    );

    expect(passages).toHaveLength(1);
    const body = passages[0].body;
    expect(body).toContain("word300 word301");
    expect(body.length).toBeLessThanOrEqual(1200);
    expect(words).toContain(body);
    const start = words.indexOf(body);
    expect(start === 0 || words[start - 1] === " ").toBe(true);
    const end = start + body.length;
    expect(end === words.length || words[end] === " ").toBe(true);
  });

  it("uses blank lines as breaks and collapses long runs of them", () => {
    const text = "# Heading\n\n\n\nFirst paragraph without a stop\n\nSecond paragraph with the otter fact";
    const passages = buildQuizPassages(
      [question("q", 1, at(text, "otter fact"))],
      new Map([[MAIN, { title: "Notes", text }]]),
      MAIN,
    );

    expect(passages[0].body).toBe(
      "# Heading\n\nFirst paragraph without a stop\n\nSecond paragraph with the otter fact",
    );
  });

  it("places every placeable question exactly once, with stable ids", () => {
    const questions = Array.from({ length: 40 }, (_, n) =>
      question(`q${n}`, n + 1, at(ARTICLE, `fact numbered ${(n * 37) % 120} `)),
    );

    const first = buildQuizPassages(questions, sources, MAIN);
    const second = buildQuizPassages([...questions].reverse(), sources, MAIN);

    expect(second).toEqual(first);
    const placed = first.flatMap((p) => p.questionIds);
    expect([...placed].sort()).toEqual(questions.map((q) => q.id).sort());
    expect(new Set(first.map((p) => p.id)).size).toBe(first.length);
    for (const passage of first) {
      expect(passage.id.startsWith(`${MAIN}:`)).toBe(true);
      expect(passage.body.length).toBeLessThanOrEqual(1200);
    }
  });
});
