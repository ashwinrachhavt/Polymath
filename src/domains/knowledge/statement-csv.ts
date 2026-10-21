import type { StatementTransaction } from "./statement-import";
import { classifyTransactions, type ClassifyOptions } from "./transaction-classify";

/*
 * The ledger CSV. One artefact, three columns: Date, Description, Amount.
 * Amount is signed — money out negative, money in positive — so the column can
 * be summed directly in a spreadsheet, which is the entire reason the file
 * exists.
 *
 * Dates are ISO so they sort as dates in every locale. Amounts carry no
 * thousands separator and no currency symbol because both make a spreadsheet
 * store the cell as text. The BOM is there so Excel reads UTF-8 (descriptions
 * can contain non-ASCII) instead of mojibake.
 */

export const LEDGER_CSV_COLUMNS = ["Date", "Description", "Amount"] as const;

/** RFC 4180: a field is quoted when it holds a comma, quote, or newline. */
function field(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function money(value: string): string {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

export function buildLedgerCsv(transactions: StatementTransaction[]): string {
  const lines = [LEDGER_CSV_COLUMNS.join(",")];
  for (const row of transactions) {
    lines.push([field(row.occurredOn), field(row.description), money(row.amount)].join(","));
  }
  // CRLF is what RFC 4180 specifies and what Excel writes.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** "ICICI Account - 2026-08-01 to 2026-08-31.csv" — readable, and safe as a filename. */
export function ledgerCsvFilename(accountLabel: string, periodStart: string | null, periodEnd: string | null): string {
  const label = accountLabel
    .replace(/[^\w .-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Statement";
  const period = periodStart && periodEnd ? ` ${periodStart} to ${periodEnd}` : periodStart ? ` ${periodStart}` : "";
  return `${label}${period}.csv`;
}

export const CLASSIFIED_CSV_COLUMNS = ["Date", "Description", "Amount", "Category", "Confidence", "Needs review"] as const;

/**
 * The ledger plus a category per row. Kept as a separate export so the plain
 * three-column ledger stays the contract. Rows the classifier is unsure of are
 * flagged "yes" rather than given a confident-looking guess.
 */
export function buildClassifiedLedgerCsv(transactions: StatementTransaction[], options: ClassifyOptions = {}): string {
  const judgments = classifyTransactions(transactions, options);
  const lines = [CLASSIFIED_CSV_COLUMNS.join(",")];
  transactions.forEach((row, index) => {
    const judgment = judgments[index];
    lines.push(
      [
        field(row.occurredOn),
        field(row.description),
        money(row.amount),
        field(judgment.category),
        judgment.confidence.toFixed(2),
        judgment.route === "review" ? "yes" : "no",
      ].join(","),
    );
  });
  return `\ufeff${lines.join("\r\n")}\r\n`;
}
