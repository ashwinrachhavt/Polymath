import { describe, expect, it } from "vitest";
import { buildLedgerCsv, ledgerCsvFilename } from "@/domains/knowledge/statement-csv";
import type { StatementTransaction } from "@/domains/knowledge/statement-import";

/*
 * The CSV is the artefact the owner's parent actually opens, so its shape is a
 * contract: three columns, a signed amount that sums, ISO dates that sort, and
 * quoting that survives a description containing a comma.
 *
 * Value: protects=the download is summable in Excel and Sheets, and a
 * description with punctuation cannot shift every later column;
 * fails_when=the amount keeps a thousands separator or a currency symbol
 * (spreadsheets store it as text), the date is locale-dependent, or a comma in
 * a narration is written unquoted; why_new=no exporter existed;
 * seam=buildLedgerCsv, a pure function over transaction rows;
 * no_claim=Excel's or Numbers' own import dialogs.
 */

function row(overrides: Partial<StatementTransaction>): StatementTransaction {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspaceId: "00000000-0000-0000-0000-000000000000",
    importId: "00000000-0000-0000-0000-000000000000",
    accountLabel: "Account",
    occurredOn: "2026-08-01",
    description: "Payment",
    rawDescription: "Payment",
    amount: "-10.00",
    balanceAfter: "100.00",
    position: 0,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("buildLedgerCsv", () => {
  it("writes exactly three columns with a signed amount", () => {
    const csv = buildLedgerCsv([
      row({ amount: "-44546.00", description: "Loan EMI" }),
      row({ amount: "4000.00", description: "Deposit", position: 1 }),
    ]);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Date,Description,Amount");
    expect(lines[1]).toBe("2026-08-01,Loan EMI,-44546.00");
    expect(lines[2]).toBe("2026-08-01,Deposit,4000.00");
  });

  it("sums to zero when out and in cancel", () => {
    const csv = buildLedgerCsv([
      row({ amount: "-500.00" }),
      row({ amount: "500.00", position: 1 }),
    ]);
    const sum = csv
      .replace(/^﻿/, "")
      .trimEnd()
      .split("\r\n")
      .slice(1)
      .map((line) => Number(line.split(",")[2]))
      .reduce((total, value) => total + value, 0);
    expect(sum).toBe(0);
  });

  it("quotes a description containing a comma instead of shifting columns", () => {
    const csv = buildLedgerCsv([row({ description: "Transfer, to savings" })]);
    expect(csv).toContain('"Transfer, to savings"');
    expect(csv).not.toContain("Transfer, to savings,");
  });

  it("escapes an embedded quote by doubling it", () => {
    const csv = buildLedgerCsv([row({ description: 'Payment "rent"' })]);
    expect(csv).toContain('"Payment ""rent"""');
  });

  it("writes amounts without separators or a currency symbol", () => {
    const csv = buildLedgerCsv([row({ amount: "1234567.5" })]);
    expect(csv).toContain(",1234567.50");
    expect(csv).not.toMatch(/\d,\d{3}/);
    expect(csv).not.toMatch(/[₹$€£]/);
  });

  it("starts with a BOM so Excel reads UTF-8", () => {
    expect(buildLedgerCsv([]).startsWith("﻿")).toBe(true);
  });
});

describe("ledgerCsvFilename", () => {
  it("names the file after the account and the period", () => {
    expect(ledgerCsvFilename("ICICI Account 5373", "2026-08-01", "2026-08-31")).toBe(
      "ICICI Account 5373 2026-08-01 to 2026-08-31.csv",
    );
  });

  it("strips characters that a filesystem or header would reject", () => {
    expect(ledgerCsvFilename('Acct/one: "two"', null, null)).toBe("Acct one two.csv");
  });
});
