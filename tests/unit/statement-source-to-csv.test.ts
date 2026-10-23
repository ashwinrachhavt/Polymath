import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStatementTables, type ParsedTable } from "@/domains/knowledge/statement-parse";
import { buildLedgerCsv, LEDGER_CSV_COLUMNS } from "@/domains/knowledge/statement-csv";

/*
 * ASH-202 end-to-end seam, no database: sanitized Docling table grids from
 * real statements -> parsed ledger -> the exact file the export button serves.
 *
 * Value: protects=the promise that the CSV holds every transaction line once,
 * with signed amounts and nothing else - no headers, no balance summaries,
 * no invented rows; fails_when=a page's rows go missing between parse and
 * file, a sign flips, a balance/header line leaks into the export, or the
 * three-column contract drifts; why_new=parse and CSV had separate coverage
 * but the chain between them is what the owner downloads; seam=the pure
 * functions over the real sanitized fixtures; no_claim=hosted Docling output
 * fidelity (fixtures are its recorded output) or the route's 409 gate
 * (covered by statement-panel-render.test.ts).
 */

function fixture(name: string): ParsedTable[] {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/statements", name), "utf8"));
  return raw.tables as ParsedTable[];
}

/** The route's gate, mirrored: a CSV is only ever built from a reconciled parse. */
function csvFromFixture(name: string): { csv: string; rowCount: number } {
  const result = parseStatementTables(fixture(name));
  expect(result.status).toBe("parsed");
  if (result.status !== "parsed") throw new Error("unreachable");
  expect(result.reconciled).toBe(true);
  const csv = buildLedgerCsv(
    result.rows.map((row) => ({
      occurredOn: row.occurredOn,
      description: row.description,
      amount: row.amount,
    })) as never,
  );
  return { csv, rowCount: result.rows.length };
}

function lines(csv: string): string[] {
  return csv.replace(/^﻿/, "").trim().split("\r\n");
}

describe("statement source to CSV", () => {
  it("multi-page mixed-layout statement: every parsed row appears exactly once as three columns", () => {
    const { csv, rowCount } = csvFromFixture("icici-savings-mixed-header.json");
    const rows = lines(csv);
    expect(rows[0]).toBe(LEDGER_CSV_COLUMNS.join(","));
    expect(rows).toHaveLength(rowCount + 1);
    expect(rowCount).toBe(75);
    // Every data line: ISO date, description, signed amount with two decimals.
    for (const line of rows.slice(1)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2},.+,(-?)\d+\.\d{2}$/);
    }
  });

  it("newest-first multi-account statement: each account block is chronological, money out is negative", () => {
    const { csv } = csvFromFixture("sofi-newest-first-two-accounts.json");
    const rows = lines(csv).slice(1);
    const dates = rows.map((line) => line.slice(0, 10));
    // Two accounts are chained separately (correct), so the file holds two
    // contiguous chronological blocks rather than one global sort.
    const blocks: string[][] = [[]];
    for (const date of dates) {
      const current = blocks[blocks.length - 1];
      if (current.length > 0 && date < current[current.length - 1]) blocks.push([]);
      blocks[blocks.length - 1].push(date);
    }
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(block).toEqual([...block].sort());
    // Both directions present and signed: the file sums correctly in a sheet.
    expect(rows.some((line) => /,-\d+\.\d{2}$/.test(line))).toBe(true);
    expect(rows.some((line) => /,\d+\.\d{2}$/.test(line))).toBe(true);
  });

  it("headers, totals and balance lines never leak into the export", () => {
    for (const name of ["icici-savings-mixed-header.json", "sofi-newest-first-two-accounts.json", "sofi-three-account-blocks.json", "icici-current-data-header.json"]) {
      const { csv } = csvFromFixture(name);
      const body = lines(csv).slice(1).join("\n").toLowerCase();
      for (const banned of ["opening balance", "closing balance", "beginning balance", "ending balance", "current balance", "brought forward", "carried forward", "transaction date", "description", "withdrawal", "deposit", "total"]) {
        expect(body.includes(banned), `${name} leaked '${banned}' into the CSV`).toBe(false);
      }
    }
  });

  it("a non-statement yields no CSV at all: the parse reports unsupported", () => {
    const result = parseStatementTables(fixture("loanlabs-paystub-not-a-statement.json"));
    expect(result.status).toBe("unsupported");
  });

  it("a broken balance chain is reported, never exported", () => {
    // A deterministic mini-statement: row two's printed balance does not
    // carry the chain forward, so the parse must say unreconciled and name
    // the row - the verdict that keeps the export button closed.
    const broken: ParsedTable[] = [
      {
        page: 1,
        numRows: 3,
        numCols: 4,
        cells: [
          { row: 0, col: 0, text: "Date", header: true },
          { row: 0, col: 1, text: "Description", header: true },
          { row: 0, col: 2, text: "Amount", header: true },
          { row: 0, col: 3, text: "Balance", header: true },
          { row: 1, col: 0, text: "Jan 2, 2026" },
          { row: 1, col: 1, text: "GYM CLUB FEES" },
          { row: 1, col: 2, text: "-10.00" },
          { row: 1, col: 3, text: "90.00" },
          { row: 2, col: 0, text: "Jan 3, 2026" },
          { row: 2, col: 1, text: "CORNER CAFE" },
          { row: 2, col: 2, text: "-5.00" },
          { row: 2, col: 3, text: "999.00" },
        ],
      },
    ];
    const result = parseStatementTables(broken);
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    expect(result.reconciled).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0].description).toContain("CORNER CAFE");
  });
});
