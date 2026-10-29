import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { looksLikeStatement } from "@/domains/knowledge/statement-parse";
import { classifyDocument } from "@/domains/knowledge/vocabulary";
import { StatementStripView, type StatementStripData } from "@/app/(workspace)/polymath/knowledge/statement-section";

/*
 * ASH-202: upload -> detect bank statement -> read transactions -> export CSV.
 *
 * Value: protects=the detection gate that decides a document is a bank
 * statement without anyone asking, and the strip that offers the export only
 * for a reconciled ledger; fails_when=a statement upload goes undetected, a
 * non-statement is sent to the parser, or the CSV is offered for rows that do
 * not add up; why_new=detection and the viewer strip are new; seam=the pure
 * predicate, the rules classifier, and the strip rendered to static markup;
 * no_claim=Docling's table reading (covered by statement-parse.test.ts) and
 * the database import.
 */

// The shape of his SoFi statement's extracted text: balance lines, a named
// statement period and a transaction ledger.
const SOFI_TEXT = [
  "Primary Account Holder",
  "Member since Mar 14, 2024",
  "Monthly Statement Period",
  "Jan 1, 2026 - Jan 31, 2026",
  "Checking Account - 0625",
  "Current Balance $470.20",
  "Beginning Balance $521.35",
  "Transaction Details",
  "Jan 31, 2026 Interest Earned $0.15",
].join("\n");

const RESUME_TEXT = [
  "Ashwin Rachha",
  "Experience",
  "Senior Software Engineer, Example Corp, 2021-2026",
  "Education",
  "B.S. Computer Science",
  "Skills: TypeScript, distributed systems",
].join("\n");

describe("looksLikeStatement", () => {
  it("detects a statement from its structural vocabulary", () => {
    expect(looksLikeStatement(SOFI_TEXT, "sofi-january-2026.pdf")).toBe(true);
  });

  it("does not send an ordinary document to the statement parser", () => {
    expect(looksLikeStatement(RESUME_TEXT, "resume.pdf")).toBe(false);
  });

  it("accepts one marker when the file or text names itself a statement", () => {
    expect(looksLikeStatement("Beginning balance was $521.35 and some prose.", "statement-jan.pdf")).toBe(true);
    expect(looksLikeStatement("Beginning balance was $521.35 and some prose.", "export.pdf")).toBe(false);
  });

  it("tolerates empty text and no filename", () => {
    expect(looksLikeStatement("", null)).toBe(false);
  });
});

describe("classifyDocument statement rules", () => {
  it("classifies a bank statement with high confidence from its balances and period", () => {
    const result = classifyDocument({ text: SOFI_TEXT, fieldNames: [], filename: "sofi-january-2026.pdf" });
    expect(result.docType).toBe("statement");
    expect(result.confidence).toBe("high");
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("keeps a bare 'statement' mention a low-confidence proposal", () => {
    const result = classifyDocument({ text: "Please find attached the statement of work.", fieldNames: [] });
    expect(result.docType).toBe("statement");
    expect(result.confidence).toBe("low");
  });

  it("reads a statement period or transaction ledger as medium confidence", () => {
    const result = classifyDocument({ text: "Statement period: Jan 1 - Jan 31. Thank you for banking with us.", fieldNames: [] });
    expect(result.docType).toBe("statement");
    expect(result.confidence).toBe("medium");
  });
});

const reconciled: StatementStripData = {
  extraction: "succeeded",
  looksLikeStatement: true,
  import: {
    status: "parsed",
    reconciled: true,
    accountLabel: "Checking Account - 0625",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    transactionCount: 6,
    error: null,
  },
};

describe("StatementStripView", () => {
  it("offers Export transactions to CSV for a reconciled statement", () => {
    const html = renderToStaticMarkup(
      createElement(StatementStripView, { documentId: "doc-1", status: reconciled, reading: false, onRead: () => {}, error: null }),
    );
    expect(html).toContain("Export transactions to CSV");
    expect(html).toContain("/api/v1/documents/doc-1/statement");
    expect(html).toContain("Checking Account - 0625");
    expect(html).toContain("6 transactions");
  });

  it("withholds the export when the rows do not reconcile", () => {
    const html = renderToStaticMarkup(
      createElement(StatementStripView, {
        documentId: "doc-1",
        status: {
          ...reconciled,
          import: { ...reconciled.import!, status: "needs_review", reconciled: false, error: "2 rows do not carry the running balance forward." },
        },
        reading: false,
        onRead: () => {},
        error: null,
      }),
    );
    expect(html).not.toContain("Export transactions to CSV");
    expect(html).toContain("do not carry the running balance forward");
    expect(html).toContain("/polymath/knowledge?doc=doc-1");
  });

  it("offers to read transactions when a statement has no ledger yet", () => {
    const html = renderToStaticMarkup(
      createElement(StatementStripView, {
        documentId: "doc-1",
        status: { extraction: "succeeded", looksLikeStatement: true, import: null },
        reading: false,
        onRead: () => {},
        error: null,
      }),
    );
    expect(html).toContain("Read transactions");
  });

  it("renders nothing for a document that is not a statement", () => {
    const html = renderToStaticMarkup(
      createElement(StatementStripView, {
        documentId: "doc-1",
        status: { extraction: "succeeded", looksLikeStatement: false, import: null },
        reading: false,
        onRead: () => {},
        error: null,
      }),
    );
    expect(html).toBe("");
  });

  it("says why when a statement-looking document yields no transaction table", () => {
    const html = renderToStaticMarkup(
      createElement(StatementStripView, {
        documentId: "doc-1",
        status: {
          extraction: "succeeded",
          looksLikeStatement: true,
          import: { status: "unsupported", reconciled: false, accountLabel: "Account", periodStart: null, periodEnd: null, transactionCount: 0, error: "No table on this document has both a date column and an amount column." },
        },
        reading: false,
        onRead: () => {},
        error: null,
      }),
    );
    expect(html).toContain("No table on this document has both a date column and an amount column");
    expect(html).not.toContain("Export transactions to CSV");
  });
});
