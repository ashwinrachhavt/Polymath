import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explanatoryText, isExplanatorySpan, isLinkIndex, textBlocks } from "@/domains/learning/explanatory-text";
import { verifyQuiz } from "@/domains/learning/generate-quiz";
import { buildQuizPassages } from "@/domains/learning/quiz-passages";

/*
 * A quiz reads only text that explains something. The fixture is a saved
 * docs page: a site notice, real paragraphs, an index of links with one-line
 * glosses (the shape the owner was quizzed on), a code block and a table of
 * contents.
 *
 * Value: protects=no question and no read-first passage is cut from a link
 * index, a table of contents or a site notice, and a source that is only an
 * index is recognised; fails_when=an index passes as prose, or prose with a
 * link in it is refused; seam=the pure classifier, plus verifyQuiz and
 * buildQuizPassages which apply it; no_claim=what the model writes.
 */

const PAGE = readFileSync(join(__dirname, "../fixtures/learning/docs-page-with-link-index.md"), "utf8");

const kindAt = (text: string, needle: string) => {
  const at = text.indexOf(needle);
  return textBlocks(text).find((block) => block.start <= at && at < block.end)?.kind;
};

const span = (text: string, quote: string) => {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`quote not in text: ${quote}`);
  return { start, end: start + quote.length };
};

describe("textBlocks", () => {
  it("names each part of a saved docs page", () => {
    expect(kindAt(PAGE, "Fetch the complete documentation index")).toBe("notice");
    expect(kindAt(PAGE, "# Example Servers")).toBe("heading");
    expect(kindAt(PAGE, "A server gives a language model")).toBe("prose");
    expect(kindAt(PAGE, "**[Git]")).toBe("links");
    expect(kindAt(PAGE, "npx -y")).toBe("code");
    expect(kindAt(PAGE, "2. Getting started")).toBe("outline");
  });

  it("keeps a paragraph that merely contains a link", () => {
    const text =
      "The protocol uses [JSON-RPC](https://www.jsonrpc.org) to carry messages, so each request has an id and the reply repeats it.";
    expect(textBlocks(text).map((block) => block.kind)).toEqual(["prose"]);
  });

  it("keeps a list whose items explain, even when each opens with a link", () => {
    const text = [
      "- [Tools](https://x.test/tools) are functions the model may call, and the server decides whether each call is allowed before it runs anything.",
      "- [Resources](https://x.test/resources) are read-only data the client loads into context, which means they can never change state on the server.",
    ].join("\n");
    expect(textBlocks(text).map((block) => block.kind)).toEqual(["prose"]);
  });

  it("refuses a navigation row and a bare list of URLs", () => {
    expect(textBlocks("[Home](/) | [Docs](/docs) | [Blog](/blog)")[0].kind).toBe("links");
    expect(textBlocks("- https://a.test/one\n- https://a.test/two")[0].kind).toBe("links");
  });

  it("splits a list from the sentence that introduces it", () => {
    const text =
      "These are the servers we maintain ourselves:\n* [A](https://a.test) - first\n* [B](https://b.test) - second";
    expect(textBlocks(text).map((block) => block.kind)).toEqual(["prose", "links"]);
  });
});

describe("isLinkIndex", () => {
  it("is false for a page with real paragraphs around its index", () => {
    expect(isLinkIndex(PAGE)).toBe(false);
  });

  it("is true for a page that is only an index", () => {
    const index = PAGE.slice(PAGE.indexOf("## Reference implementations"), PAGE.indexOf("## Getting started"));
    expect(isLinkIndex(`# Example Servers\n\n${index}`)).toBe(true);
  });

  it("is false for a short note in plain words", () => {
    expect(isLinkIndex("The lease renews on March 1. Rent rises by 4%.")).toBe(false);
  });
});

describe("explanatoryText", () => {
  it("drops the index, the outline and the notice, and keeps the rest verbatim", () => {
    const kept = explanatoryText(PAGE);
    expect(kept).not.toContain("**[Everything]");
    expect(kept).not.toContain("llms.txt");
    expect(kept).not.toContain("4. Community servers");
    expect(kept).toContain("# Example Servers");
    expect(kept).toContain("Because every server speaks the same protocol");
    expect(kept).toContain("npx -y @example/server-memory");
  });

  it("returns a source with nothing to drop unchanged", () => {
    const text = "One line.\n\n\n\nAnother line, after odd spacing.";
    expect(explanatoryText(text)).toBe(text);
  });
});

describe("questions and passages from a link index", () => {
  const INDEX_QUOTE = "Tools to read, search, and manipulate Git repositories";
  const PROSE_QUOTE = "The `npx` command downloads a TypeScript server and starts it in one step";

  it("tells an index entry from a sentence of the page", () => {
    expect(isExplanatorySpan(textBlocks(PAGE), span(PAGE, INDEX_QUOTE))).toBe(false);
    expect(isExplanatorySpan(textBlocks(PAGE), span(PAGE, PROSE_QUOTE))).toBe(true);
  });

  it("drops a proposed question whose quote is an index entry", () => {
    const proposal = (quote: string) => ({
      prompt: "What does it do?",
      choices: [
        { value: "a", label: "One claim." },
        { value: "b", label: "Another claim." },
      ],
      answerValue: "a",
      explanation: "Because the page says so.",
      quote,
    });
    const verified = verifyQuiz(PAGE, [proposal(INDEX_QUOTE), proposal(PROSE_QUOTE)]);
    expect(verified.questions.map((q) => q.evidence.quote)).toEqual([PROSE_QUOTE]);
    expect(verified.droppedQuestions).toBe(1);
  });

  it("gives a stored question about the index no passage, and the prose question a clean one", () => {
    const evidence = (quote: string) => ({
      quote,
      startOffset: span(PAGE, quote).start,
      endOffset: span(PAGE, quote).end,
    });
    const passages = buildQuizPassages(
      [
        { id: "index", ordinal: 0, evidence: evidence(INDEX_QUOTE) },
        { id: "prose", ordinal: 1, evidence: evidence(PROSE_QUOTE) },
      ],
      new Map([["e1", { title: "Example Servers", text: PAGE }]]),
      "e1",
    );
    expect(passages.map((passage) => passage.questionIds)).toEqual([["prose"]]);
    expect(passages[0].body).toContain(PROSE_QUOTE);
    expect(passages[0].body).not.toContain("](https://");
  });
});
