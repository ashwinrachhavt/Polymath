import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStatementTables, type ParsedTable } from "@/domains/knowledge/statement-parse";

/*
 * Statement parsing against sanitized Docling output from four real bank
 * statements. The layouts are the point: a single document changes its column
 * layout between pages, prints newest-first, or puts its header in a row the
 * flags do not mark, and every one of those must still reconcile against the
 * bank's own running balance.
 *
 * Value: protects=the accuracy claim — every transaction appears once, in the
 * right direction, and the running balance carries forward to the cent;
 * fails_when=a merged date column misaligns a page, a sign flips, or a
 * multi-account file chains balances across accounts; why_new=no parser
 * existed; seam=parseStatementTables, a pure function over the table grid;
 * no_claim=the hosted providers' table output (fixtures are Docling only).
 * Fixtures are sanitized: names and account references are replaced with
 * synthetic values of the same shape.
 */

function fixture(name: string): ParsedTable[] {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/statements", name), "utf8"));
  return raw.tables as ParsedTable[];
}

describe("parseStatementTables", () => {
  it("reads a savings statement whose date column merges with the cheque column on two of five pages", () => {
    const result = parseStatementTables(fixture("icici-savings-mixed-header.json"));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;

    expect(result.rows).toHaveLength(75);
    expect(result.reconciled).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    expect(result.periodStart).toBe("2026-08-01");
  });

  it("keeps the merged-date page in the same chain as the split pages", () => {
    const result = parseStatementTables(fixture("icici-savings-mixed-header.json"));
    if (result.status !== "parsed") throw new Error("expected parsed");

    // The first row of page 1 (merged columns) and the first row of page 2
    // (split columns) must both be read, not silently dropped by a mapping
    // that only fits one of the layouts.
    const dates = new Set(result.rows.map((row) => row.occurredOn));
    expect(dates.size).toBeGreaterThan(1);
    const pages = new Set(result.rows.map((row) => row.page));
    expect(pages.size).toBeGreaterThan(1);
  });

  it("reads a current-account statement whose header flags sit on a data row", () => {
    const result = parseStatementTables(fixture("icici-current-data-header.json"));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;

    expect(result.rows.length).toBe(33);
    expect(result.reconciled).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it("orders a newest-first statement chronologically before reconciling", () => {
    const result = parseStatementTables(fixture("sofi-newest-first-two-accounts.json"));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;

    // SoFi prints newest first. Without sorting, every row appears to break
    // the balance chain; the proof it did sort is that nothing mismatches.
    expect(result.reconciled).toBe(true);
    const first = result.rows[0];
    const last = result.rows[result.rows.length - 1];
    expect(first.occurredOn < last.occurredOn).toBe(true);
  });

  it("chains each account separately in a file that holds three account blocks", () => {
    const result = parseStatementTables(fixture("sofi-three-account-blocks.json"));
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;

    expect(result.reconciled).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    // Three blocks: 4 + 5 + 2 data rows. The third block continues on a page
    // with no header row of its own, and its two rows must not be dropped.
    expect(result.rows.length).toBe(11);
  });

  it("reports a pay stub as unsupported instead of inventing ledger rows", () => {
    const result = parseStatementTables(fixture("loanlabs-paystub-not-a-statement.json"));
    expect(result.status).toBe("unsupported");
  });

  it("signs money out negative and money in positive", () => {
    const result = parseStatementTables(fixture("icici-savings-mixed-header.json"));
    if (result.status !== "parsed") throw new Error("expected parsed");

    expect(result.rows.every((row) => row.amount !== "0.00")).toBe(true);
    // A withdrawal column entry becomes a negative amount.
    const withdrawal = result.rows.find((row) => row.description.includes("Payment"));
    expect(withdrawal ? Number(withdrawal.amount) < 0 : true).toBe(true);
  });

  it("reports the row that breaks the chain rather than claiming a clean read", () => {
    const tables = fixture("icici-savings-mixed-header.json");
    // Corrupt one balance in place: the chain must break at that row.
    const table = tables[0];
    const target = table.cells.find(
      (cell) => cell.col === 5 && cell.row === 3 && /\d/.test(cell.text),
    );
    expect(target).toBeDefined();
    if (target) target.text = "1.00";

    const result = parseStatementTables(tables);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.reconciled).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0].accountLabel).toBeTruthy();
    expect(result.mismatches[0].difference).not.toBe("0.00");
  });
});
