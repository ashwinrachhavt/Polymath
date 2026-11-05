import { describe, expect, it } from "vitest";
import { locateQuote, summaryToMarkdown, verifyReadingSummary } from "@/domains/knowledge/reading-summary";

/*
 * The summarizer's trust boundary: the model proposes claims with quotes,
 * the domain keeps only quotes that are verbatim passages of the source
 * text. Anything else - paraphrase, reconstruction, invention - is dropped
 * and counted.
 */

const TEXT = "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days.";

describe("locateQuote", () => {
  it("finds a verbatim passage and returns its span", () => {
    expect(locateQuote(TEXT, "Rent rises by 4%")).toEqual({ start: 29, end: 45 });
  });
  it("refuses a paraphrase", () => {
    expect(locateQuote(TEXT, "Rent goes up 4 percent")).toBeNull();
  });
  it("refuses an empty quote", () => {
    expect(locateQuote(TEXT, "   ")).toBeNull();
  });
});

describe("verifyReadingSummary", () => {
  it("keeps proven claims, drops unproven ones, and counts the drops", () => {
    const out = verifyReadingSummary(TEXT, {
      summary: "A lease renewal letter.",
      keyClaims: [
        { claim: "The lease renews March 1.", quote: "The lease renews on March 1." },
        { claim: "The landlord can raise rent at will.", quote: "rent may be raised at any time" },
      ],
      openQuestions: ["Is the increase capped by local law?"],
    });
    expect(out.keyClaims.map((c) => c.claim)).toEqual(["The lease renews March 1."]);
    expect(out.droppedClaims).toBe(1);
    expect(out.openQuestions).toEqual(["Is the increase capped by local law?"]);
    expect(out.summary).toBe("A lease renewal letter.");
  });

  it("caps claims and questions and trims blanks", () => {
    const quote = "The lease renews on March 1.";
    const out = verifyReadingSummary(TEXT, {
      summary: "x",
      keyClaims: Array.from({ length: 9 }, (_, i) => ({ claim: `claim ${i}`, quote })),
      openQuestions: ["a", " ", "b", "c", "d", "e", "f"],
    });
    expect(out.keyClaims).toHaveLength(7);
    expect(out.openQuestions).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps a long claim whole — the claim is the card's content, no length clamp", () => {
    // The old 400-char clamp retired with the review queue: content length is
    // the summarizer's judgment, capped only by the card title's own rule.
    const longClaim = `${"The renewal window reopens every March and requires written notice, ".repeat(8)}and rent then rises by 4%.`;
    const quote = "The lease renews on March 1.";
    const out = verifyReadingSummary(TEXT, {
      summary: "x",
      keyClaims: [{ claim: longClaim, quote }],
      openQuestions: [],
    });
    expect(out.keyClaims).toHaveLength(1);
    expect(out.keyClaims[0].claim).toBe(longClaim);
    expect(out.keyClaims[0].claim.length).toBeGreaterThan(400);
  });
});

describe("summaryToMarkdown", () => {
  it("joins the summary and questions with a divider", () => {
    const md = summaryToMarkdown({ summary: "A letter.", openQuestions: ["Why now?"] });
    expect(md).toBe("A letter.\n\n---\n\nOpen questions\n- Why now?");
  });
  it("is the summary alone when there are no questions", () => {
    expect(summaryToMarkdown({ summary: "A letter.", openQuestions: [] })).toBe("A letter.");
  });
});
