import { describe, expect, it } from "vitest";
import {
  checkTotals,
  detectMoneyFormat,
  parseStatementTables,
  type ParsedTable,
} from "@/domains/knowledge/statement-parse";

/*
 * Value: protects=the two silent-corruption paths in statement parsing (a
 * decimal-comma amount read as the wrong number, a spanning date cell that
 * drops rows) and the statement's own printed totals as a second check;
 * fails_when=1.234,56 parses as 1.23456, a rowSpan date is lost, or a printed
 * total that disagrees with the rows is ignored; why_new=Tier 1 hardening on
 * the running-balance gate; seam=parseStatementTables over synthetic grids;
 * no_claim=real Docling output (fixtures here are synthetic, no real data).
 */

function table(header: string[], data: string[][], spans: Record<string, { rowSpan?: number; colSpan?: number }> = {}): ParsedTable {
  const cells: ParsedTable["cells"] = [];
  header.forEach((text, col) => cells.push({ row: 0, col, text, header: true, rowSpan: 1, colSpan: 1 }));
  data.forEach((row, r) =>
    row.forEach((text, col) => {
      if (text === "\u0000") return; // position covered by a span: Docling emits no cell
      const span = spans[`${r + 1}:${col}`] ?? {};
      cells.push({ row: r + 1, col, text, header: false, rowSpan: span.rowSpan ?? 1, colSpan: span.colSpan ?? 1 });
    }),
  );
  return { page: 1, numRows: data.length + 1, numCols: header.length, cells };
}

const HEADER = ["Date", "Description", "Withdrawal", "Deposit", "Balance"];

describe("decimal-comma statements", () => {
  const rows = [
    ["01.08.2026", "Opening salary", "", "1.500,00", "11.500,00"],
    ["02.08.2026", "Rent", "1.234,56", "", "10.265,44"],
    ["03.08.2026", "Groceries", "65,44", "", "10.200,00"],
  ];

  it("detects the format from the document and reads amounts correctly", () => {
    const t = table(HEADER, rows);
    expect(detectMoneyFormat([t])).toBe("comma");
    const result = parseStatementTables([t]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.moneyFormat).toBe("comma");
    expect(result.rows.map((r) => r.amount)).toEqual(["1500.00", "-1234.56", "-65.44"]);
    expect(result.reconciled).toBe(true);
  });

  it("keeps dot-decimal documents on the dot rule, including lakh grouping", () => {
    const t = table(HEADER, [
      ["01-08-2026", "Salary", "", "1,50,000.00", "2,50,000.00"],
      ["02-08-2026", "Rent", "12,345.67", "", "2,37,654.33"],
    ]);
    expect(detectMoneyFormat([t])).toBe("dot");
    const result = parseStatementTables([t]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.rows.map((r) => r.amount)).toEqual(["150000.00", "-12345.67"]);
    expect(result.reconciled).toBe(true);
  });

  it("refuses a document that mixes both formats instead of guessing", () => {
    const t = table(HEADER, [
      ["01.08.2026", "Salary", "", "1.500,00", "2.500,00"],
      ["02.08.2026", "Rent", "100.00", "", "2.400,00"],
    ]);
    expect(detectMoneyFormat([t])).toBe("dot");
    const result = parseStatementTables([t]);
    // The comma values are rejected, so no row is silently read as 1.5.
    if (result.status === "parsed") {
      for (const row of result.rows) expect(Number(row.amount)).not.toBeCloseTo(1.5);
    }
  });
});

describe("spanning cells", () => {
  it("repeats a date that is printed once for a group of rows", () => {
    const t = table(
      HEADER,
      [
        ["05-Aug-2026", "Coffee", "4.50", "", "995.50"],
        ["\u0000", "Lunch", "12.00", "", "983.50"],
        ["\u0000", "Refund", "", "20.00", "1,003.50"],
        ["06-Aug-2026", "Bus", "3.50", "", "1,000.00"],
      ],
      { "1:0": { rowSpan: 3 } },
    );
    const result = parseStatementTables([t]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.rows).toHaveLength(4);
    expect(result.rows.slice(0, 3).every((r) => r.occurredOn === "2026-08-05")).toBe(true);
    expect(result.reconciled).toBe(true);
  });

  it("does not let a covered position overwrite a real cell", () => {
    const t = table(HEADER, [["05-Aug-2026", "Coffee", "4.50", "", "995.50"]], {
      "1:1": { colSpan: 2 },
    });
    const result = parseStatementTables([t]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.rows[0].amount).toBe("-4.50");
  });
});

describe("totals printed by the statement", () => {
  const t = table(HEADER, [
    ["01-08-2026", "Salary", "", "100.00", "1,100.00"],
    ["02-08-2026", "Rent", "40.00", "", "1,060.00"],
  ]);

  it("matches when stated totals equal the rows", () => {
    const result = parseStatementTables([t], "Total Withdrawals: 40.00\nTotal Deposits: 100.00\nTotal transactions: 2");
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.totals.status).toBe("match");
    expect(result.reconciled).toBe(true);
  });

  it("refuses when a stated total disagrees, even though the balance chain closes", () => {
    const result = parseStatementTables([t], "Total Withdrawals: 90.00");
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.mismatches).toHaveLength(0);
    expect(result.totals.status).toBe("mismatch");
    expect(result.reconciled).toBe(false);
  });

  it("stays silent when the document prints several different totals (multi-account)", () => {
    const rows = parseStatementTables([t])
    if (rows.status !== "parsed") throw new Error("expected parsed");
    const verdict = checkTotals("Total Withdrawals: 40.00\nTotal Withdrawals: 7.00", rows.rows);
    expect(verdict.status).toBe("ambiguous");
  });

  it("is absent when no text is available", () => {
    const result = parseStatementTables([t]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.totals.status).toBe("absent");
  });
});

describe("reconciliation as router", () => {
  const us = table(HEADER, [
    ["01/02/2026", "Salary", "", "1,000.00", "2,000.00"],
    ["01/10/2026", "Rent", "400.00", "", "1,600.00"],
    ["02/03/2026", "Groceries", "100.00", "", "1,500.00"],
  ]);

  it("tries month-first dates when day-first does not reconcile, and says which reading won", () => {
    const result = parseStatementTables([us]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.reconciled).toBe(true);
    expect(result.strategy).toBe("month-first dates");
    expect(result.rows.map((r) => r.occurredOn)).toEqual(["2026-01-02", "2026-01-10", "2026-02-03"]);
    expect(result.attempts[0]).toMatchObject({ strategy: "default", reconciled: false });
  });

  it("keeps the default reading when it already reconciles", () => {
    const eu = table(HEADER, [
      ["01-08-2026", "Salary", "", "100.00", "1,100.00"],
      ["02-08-2026", "Rent", "40.00", "", "1,060.00"],
    ]);
    const result = parseStatementTables([eu]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.strategy).toBe("default");
    expect(result.attempts).toHaveLength(1);
  });

  it("returns the default result, with its named broken row, when no reading reconciles", () => {
    const broken = table(HEADER, [
      ["01-08-2026", "Salary", "", "100.00", "1,100.00"],
      ["02-08-2026", "Rent", "40.00", "", "999.00"],
    ]);
    const result = parseStatementTables([broken]);
    if (result.status !== "parsed") throw new Error("expected parsed");
    expect(result.reconciled).toBe(false);
    expect(result.strategy).toBe("default");
    expect(result.mismatches[0]).toMatchObject({ description: "Rent" });
    expect(result.attempts.length).toBeGreaterThan(1);
  });
});
