import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StatementPanel } from "@/app/(workspace)/alfred/knowledge/statement-panel";

/*
 * The panel's whole job is to make the verdict legible before the download, so
 * the assertions are about what the owner reads, not about CSS classes.
 *
 * Value: protects=an unreconciled statement offers no download and names the
 * row that broke the chain; a reconciled one offers the file and says what it
 * contains; fails_when=the download renders for a statement whose rows do not
 * add up, or the mismatch detail is hidden; why_new=the panel is new;
 * seam=StatementPanel rendered to static markup (no router, no database);
 * no_claim=the browser's own download behaviour.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const base = {
  accountLabel: "Savings Account 0625",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  openingBalance: "521.35",
  closingBalance: "470.20",
  transactionCount: 10,
  rows: [{ occurredOn: "2026-01-05", description: "GYM CLUB FEES", amount: "-10.65" }],
};

describe("StatementPanel", () => {
  it("offers the download and explains the columns when the rows reconcile", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: { ...base, status: "parsed", reconciled: true, error: null, mismatches: [] },
      }),
    );
    expect(html).toContain("/api/v1/documents/doc-1/statement");
    expect(html).toContain("Download CSV");
    expect(html).toContain("Money out is negative");
    expect(html).toContain("10");
  });

  it("withholds the download and names the broken row when it does not", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: {
          ...base,
          status: "needs_review",
          reconciled: false,
          error: "1 row does not carry the running balance forward.",
          mismatches: [{
            occurredOn: "2026-01-20",
            description: "YOUFIT CLUB FEES",
            amount: "-10.65",
            expectedBalance: "470.05",
            actualBalance: "480.70",
          }],
        },
      }),
    );
    expect(html).not.toContain("Download CSV");
    expect(html).toContain("1 row does not carry the running balance forward.");
    expect(html).toContain("2026-01-20");
    expect(html).toContain("YOUFIT CLUB FEES");
  });

  it("says plainly when the document is not a statement", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: { ...base, status: "unsupported", reconciled: false, error: "This document has no table of transactions.", mismatches: [], rows: [], transactionCount: 0 },
      }),
    );
    expect(html).toContain("Not a statement");
    expect(html).toContain("This document has no table of transactions.");
    expect(html).not.toContain("Download CSV");
  });

  it("waits for the document to be read before offering to build a ledger", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, { documentId: "doc-1", extractionSucceeded: false, statement: null }),
    );
    expect(html).toContain("Read the document first");
    expect(html).not.toContain("Build ledger");
  });
});

describe("StatementPanel categories", () => {
  const statement = {
    ...base,
    status: "parsed" as const,
    reconciled: true,
    error: null,
    mismatches: [],
    rows: [
      { id: "t-1", occurredOn: "2026-01-05", description: "STARBUCKS COFFEE", amount: "-6.50", category: "dining", needsReview: false },
      { id: "t-2", occurredOn: "2026-01-06", description: "QWZX 88 TRADING", amount: "-12.00", category: "unknown", needsReview: true },
    ],
  };

  it("lists only the unsure rows for correction, with a category choice for each", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, { documentId: "doc-1", extractionSucceeded: true, statement }),
    );
    expect(html).toContain("1 to categorise");
    expect(html).toContain("QWZX 88 TRADING");
    expect(html).not.toContain("Category for STARBUCKS");
    expect(html).toContain("Category for QWZX 88 TRADING");
  });

  it("shows no category UI when the statement was not classified", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: { ...statement, rows: [{ occurredOn: "2026-01-05", description: "GYM", amount: "-1.00" }] },
      }),
    );
    expect(html).not.toContain("to categorise");
  });
});

describe("StatementPanel verification and totals", () => {
  const parsed = { ...base, status: "parsed" as const, reconciled: true, error: null, mismatches: [] };

  it("says when the statement's own totals match and when a later reading was needed", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: { ...parsed, totalsStatus: "match", strategy: "month-first dates" },
      }),
    );
    expect(html).toContain("totals printed on the statement match");
    expect(html).toContain("Read with month-first dates");
  });

  it("stays quiet about the strategy when the default reading worked", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: { ...parsed, strategy: "default" },
      }),
    );
    expect(html).not.toContain("Read with");
  });

  it("lists spending by category, largest first as given", () => {
    const html = renderToStaticMarkup(
      createElement(StatementPanel, {
        documentId: "doc-1",
        extractionSucceeded: true,
        statement: {
          ...parsed,
          categoryTotals: [
            { category: "housing", count: 1, spent: "1200.00", received: "0.00" },
            { category: "fees_interest", count: 2, spent: "30.00", received: "0.00" },
          ],
        },
      }),
    );
    expect(html).toContain("Spending by category");
    expect(html).toContain("housing");
    expect(html).toContain("fees interest");
  });
});
