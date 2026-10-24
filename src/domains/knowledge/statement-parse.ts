/*
 * Bank statement tables -> ledger rows. Pure: takes the cell grid Docling
 * produced, returns parsed transactions and a reconciliation verdict. No
 * database, no network, so every layout can be tested against a fixture.
 *
 * Why the table grid and not the markdown: markdown loses cell coordinates, and
 * the real statements change their column layout between pages of one file
 * (ICICI merges "Transaction Date" and "Cheque Number" on some pages and
 * splits them on others). Mapping each table block independently is the only
 * way a single document parses correctly all the way through.
 *
 * The reconciliation chain is the accuracy claim. Every row either carries the
 * running balance forward to the cent, or the statement is reported as not
 * reconciled with the row that broke it.
 */

export type TableCellInput = {
  row: number;
  col: number;
  text: string;
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
};

export type ParsedTable = {
  page: number | null;
  numRows: number;
  numCols: number;
  cells: TableCellInput[];
};

export type LedgerRow = {
  occurredOn: string;
  description: string;
  rawDescription: string;
  amount: string;
  balanceAfter: string | null;
  position: number;
  accountLabel: string;
  page: number | null;
};

export type MappingReport = {
  page: number | null;
  accountLabel: string;
  header: string[];
  columns: Record<string, number>;
  rowCount: number;
};

export type ReconciliationMismatch = {
  accountLabel: string;
  position: number;
  occurredOn: string;
  description: string;
  amount: string;
  previousBalance: string;
  expectedBalance: string;
  actualBalance: string;
  difference: string;
};

/**
 * A second, independent check: totals the statement prints about itself. It
 * only speaks when the statement states a figure exactly once, because a file
 * holding several accounts prints several totals and none of them is "the"
 * total for the rows we read.
 */
export type TotalsCheck = {
  status: "match" | "mismatch" | "absent" | "ambiguous";
  checks: Array<{ label: string; stated: string; computed: string; ok: boolean }>;
};

export type ParseResult =
  | {
      status: "parsed";
      rows: LedgerRow[];
      accountLabel: string;
      periodStart: string | null;
      periodEnd: string | null;
      openingBalance: string | null;
      closingBalance: string | null;
      reconciled: boolean;
      mismatches: ReconciliationMismatch[];
      totals: TotalsCheck;
      moneyFormat: MoneyFormat;
      /** Which reading reconciled, or the default one when none did. */
      strategy: string;
      /** Every reading tried, in order, with its verdict. */
      attempts: Array<{ strategy: string; reconciled: boolean; mismatches: number; rows: number }>;
      mappings: MappingReport[];
      unsupportedTables: number;
    }
  | { status: "unsupported"; reason: string; tablesSeen: number };

/**
 * The cheap gate before a statement parse is attempted: does this document
 * read like a bank statement at all? The parser itself stays the authority on
 * whether the tables yield a ledger; this predicate only decides whether
 * trying is worthwhile, so an upload of a statement is detected and read
 * without anyone asking (ASH-202). Two structural markers, or one marker plus
 * the word "statement" in the text or filename, are enough to try.
 */
export function looksLikeStatement(text: string, filename?: string | null): boolean {
  const body = text.toLowerCase();
  const name = (filename ?? "").toLowerCase();
  const markers = [
    /\b(beginning|opening)\s+balance\b/,
    /\b(ending|closing|current)\s+balance\b/,
    /\bstatement\s+period\b/,
    /\btransaction\s+(details|history|activity)\b/,
    /\baccount\s+(summary|activity)\b/,
  ];
  const hits = markers.filter((re) => re.test(body)).length;
  if (hits >= 2) return true;
  if (hits >= 1 && (/\bstatement\b/.test(body) || /\bstatement\b/.test(name))) return true;
  return false;
}

const CENT = 0.01;

/**
 * Number format of a whole document. "1.234,56" read with the dot-decimal rule
 * becomes 1.23456, a wrong number no balance check is guaranteed to catch, so
 * the format is decided once per document and anything that does not fit it is
 * rejected (null) instead of guessed.
 */
export type MoneyFormat = "dot" | "comma";

let activeFormat: MoneyFormat = "dot";

const DOT_FORMAT = /^-?(?:\d+|\d{1,3}(?:,\d{2})*,\d{3})(?:\.\d+)?$/;
const COMMA_FORMAT = /^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/;

/** Amount and balance values stay strings in the public shape; math is internal. */
function money(value: string, format: MoneyFormat = activeFormat): number | null {
  let text = value.trim();
  if (!text) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  if (/\bdr\b/i.test(text)) sign = -1;
  if (/\bcr\b/i.test(text)) sign = 1;
  text = text
    .replace(/\b(dr|cr)\b/gi, "")
    .replace(/[₹$€£]/g, "")
    .replace(/\b(inr|usd|eur|gbp)\b/gi, "")
    .replace(/[\s\u00a0\u202f]/g, "");
  if (format === "comma") {
    if (!COMMA_FORMAT.test(text)) return null;
    return sign * Number.parseFloat(text.replace(/\./g, "").replace(",", "."));
  }
  if (!DOT_FORMAT.test(text)) return null;
  return sign * Number.parseFloat(text.replace(/,/g, ""));
}

const COMMA_MONEY_CELL = /^[-(]?\s*[₹$€£]?\s*\d[\d. \u00a0\u202f]*,\d{2}\)?(?:\s*(?:dr|cr))?$/i;
const DOT_MONEY_CELL = /^[-(]?\s*[₹$€£]?\s*\d[\d, ]*\.\d{2}\)?(?:\s*(?:dr|cr))?$/i;

/**
 * Decimal-comma only when the document shows it and never shows the dot form:
 * a statement with both is ambiguous, stays on the dot rule, and the comma
 * values are rejected so the balance gate refuses loudly.
 */
export function detectMoneyFormat(tables: ParsedTable[]): MoneyFormat {
  let comma = 0;
  let dot = 0;
  for (const table of tables) {
    for (const cell of table.cells) {
      const text = cell.text.trim();
      if (COMMA_MONEY_CELL.test(text)) comma += 1;
      else if (DOT_MONEY_CELL.test(text)) dot += 1;
    }
  }
  return comma > 0 && dot === 0 ? "comma" : "dot";
}

function fixed(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

type RawDate = { year: number; month: number; day: number; dayFirst: boolean; numeric?: true };

/**
 * Parses the date shapes the real statements use, without deciding the
 * day/month order yet. Docling splits hyphenated month names across a line
 * ("03-Aug- 2026"), so spacing is normalised before matching.
 */
function readDate(value: string): RawDate | null {
  const text = value.replace(/\s+/g, " ").trim();

  const named = text.match(/^(\d{1,2})[- ]([A-Za-z]{3,})[- ,]+(\d{4})$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return { year: Number(named[3]), month, day: Number(named[1]), dayFirst: true };
  }

  const monthFirst = text.match(/^([A-Za-z]{3,})[ -]+(\d{1,2}),?[ -]+(\d{4})$/);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return { year: Number(monthFirst[3]), month, day: Number(monthFirst[2]), dayFirst: false };
  }

  const numeric = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    // 2026-08-01 is unambiguous; it is always year first.
    if (numeric[1].length === 4 || a > 31) {
      return { year: Number(numeric[1]), month: b, day: Number(numeric[2]), dayFirst: true };
    }
    return { year, month: b, day: a, dayFirst: true, numeric: true };
  }

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), dayFirst: true };

  return null;
}

/**
 * Reading overrides the reconciliation router sets when the default reading did
 * not reconcile. Null means "decide from the document", which is the normal
 * path. Set only inside parseStatementTables, restored in its finally.
 */
let activeDayFirst: boolean | null = null;
let activeSpans = true;

function resolveDayFirst(dates: RawDate[], text: string[]): boolean {
  if (activeDayFirst !== null) return activeDayFirst;
  // A component above 12 can only be a day, which settles the whole document.
  for (const value of text) {
    const numeric = value.replace(/\s+/g, " ").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}$/);
    if (numeric && Number(numeric[1]) > 12) return true;
  }
  for (const date of dates) if (date.month > 12) return true;
  return dates.every((date) => date.dayFirst);
}

function isoDate(date: RawDate, dayFirst: boolean): string | null {
  let { day, month } = date;
  if (date.numeric && activeDayFirst === false) {
    // Forced month-first: "03/04/2026" is March 4, not April 3.
    [day, month] = [month, day];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${date.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (!dayFirst) {
    // Already unambiguous: the month name supplied the month.
    if (date.day > 12) return null;
  } else if (date.month > 12) {
    month = date.day;
    day = date.month;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${date.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Applies the spans Docling reports. A cell with colSpan fills the columns it
 * covers; a cell with rowSpan repeats into the rows below it. Real statements
 * that print a date once for a group of rows would otherwise lose every row but
 * the first. Covered positions never overwrite a cell that has its own entry.
 */
function grid(table: ParsedTable): string[][] {
  const rows: string[][] = Array.from({ length: table.numRows }, () =>
    Array.from({ length: table.numCols }, () => ""),
  );
  const owned = new Set<number>();
  const inBounds = (row: number, col: number) =>
    row >= 0 && row < table.numRows && col >= 0 && col < table.numCols;
  for (const cell of table.cells) {
    if (!inBounds(cell.row, cell.col)) continue;
    rows[cell.row][cell.col] = cell.text.trim();
    owned.add(cell.row * table.numCols + cell.col);
  }
  if (!activeSpans) return rows;
  for (const cell of table.cells) {
    if (!inBounds(cell.row, cell.col)) continue;
    const text = cell.text.trim();
    const rowSpan = Math.max(1, cell.rowSpan ?? 1);
    const colSpan = Math.max(1, cell.colSpan ?? 1);
    if (rowSpan === 1 && colSpan === 1) continue;
    for (let r = cell.row; r < Math.min(table.numRows, cell.row + rowSpan); r += 1) {
      for (let c = cell.col; c < Math.min(table.numCols, cell.col + colSpan); c += 1) {
        if (r === cell.row && c === cell.col) continue;
        if (owned.has(r * table.numCols + c)) continue;
        rows[r][c] = text;
      }
    }
  }
  return rows;
}

function headerFlags(table: ParsedTable): boolean[][] {
  const flags: boolean[][] = Array.from({ length: table.numRows }, () =>
    Array.from({ length: table.numCols }, () => false),
  );
  for (const cell of table.cells) {
    if (cell.row < 0 || cell.row >= table.numRows || cell.col < 0 || cell.col >= table.numCols) continue;
    flags[cell.row][cell.col] = Boolean(cell.header);
  }
  return flags;
}

type ColumnRole =
  | "date"
  | "dateOrCheque"
  | "description"
  | "withdrawal"
  | "deposit"
  | "amount"
  | "balance"
  | "ignore";

const ROLE_PATTERNS: Array<[ColumnRole, RegExp]> = [
  ["balance", /(balance|running bal|available bal)/i],
  ["withdrawal", /(withdrawal|debit|\bdr\b|paid out|money out)/i],
  ["deposit", /(deposit|credit|\bcr\b|paid in|money in)/i],
  ["dateOrCheque", /(transaction date.*cheque|date.*cheque|cheque.*date)/i],
  ["date", /(date)/i],
  ["description", /(description|remarks|particulars|details|narration|memo|transaction)/i],
  ["amount", /(amount)/i],
];

function roleFor(header: string): ColumnRole | null {
  const text = header.trim();
  if (!text) return null;
  // "Transaction Date Cheque Number" is one column that holds only a date on
  // most rows; it must be classified before the plain "date" rule sees it.
  for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(text)) return role;
  return null;
}

function looksLikeDateColumn(values: string[]): boolean {
  const filled = values.filter(Boolean);
  if (filled.length < 2) return false;
  const hits = filled.filter((value) => readDate(value) !== null).length;
  return hits / filled.length >= 0.6;
}

/**
 * A money column is filled on most rows, not merely numeric where filled. A
 * cheque-number column holding "630" twice and nothing else is numeric on every
 * filled cell, and counting it as money silently steals the withdrawal column's
 * role.
 */
function looksLikeMoneyColumn(values: string[], totalRows = values.length): boolean {
  if (totalRows < 2) return false;
  const filled = values.filter(Boolean);
  if (filled.length / totalRows < 0.5) return false;
  const hits = filled.filter((value) => money(value) !== null).length;
  if (hits / filled.length < 0.9) return false;
  // A serial-number column is integers that never carry a decimal or a
  // thousands separator. Money in a bank statement always does at least once.
  const looksSerial = filled.every((value) => /^\d{1,6}$/.test(value.trim()));
  return !looksSerial;
}

type BlockMapping = {
  headerRow: number;
  titleRows: number[];
  roles: Map<number, ColumnRole>;
};

function locateHeader(table: ParsedTable, rows: string[][], flags: boolean[][]): BlockMapping | null {
  let headerRow = -1;
  let best = 0;
  for (let r = 0; r < table.numRows; r += 1) {
    const count = flags[r].filter(Boolean).length;
    if (count > best) {
      best = count;
      headerRow = r;
    }
  }
  // Two header cells is the smallest row that can name a date and an amount.
  if (best < 2) headerRow = -1;

  if (headerRow === -1) {
    // No header flags: the row whose cells produce the most column roles wins.
    let bestScore = 0;
    for (let r = 0; r < Math.min(table.numRows, 4); r += 1) {
      const score = rows[r].filter((cell) => roleFor(cell) !== null).length;
      if (score > bestScore) {
        bestScore = score;
        headerRow = r;
      }
    }
    if (bestScore < 2) return null;
  }

  const roles = new Map<number, ColumnRole>();
  for (let c = 0; c < table.numCols; c += 1) {
    const role = roleFor(rows[headerRow][c]);
    if (role) roles.set(c, role);
  }

  // Column-count drift: when a page merges the date and cheque columns, the
  // header still says two things in one cell. Keep it as one date column.
  return {
    headerRow,
    titleRows: Array.from({ length: headerRow }, (_, index) => index).filter((r) =>
      rows[r].some((cell) => cell && roleFor(cell) === null),
    ),
    roles,
  };
}

/** Fallback mapping for tables whose header row is data (ICICI current account). */
function inferRoles(
  table: ParsedTable,
  rows: string[][],
  skip: number,
  ambiguousPairs: Array<[number, number]> = [],
): Map<number, ColumnRole> | null {
  const roles = new Map<number, ColumnRole>();
  const dataRows = rows.slice(skip);
  for (let c = 0; c < table.numCols; c += 1) {
    const values = dataRows.map((row) => row[c] ?? "");
    if (looksLikeDateColumn(values)) roles.set(c, "date");
  }
  // The balance is the rightmost money column; the amount is the money column
  // immediately left of it when two are consecutive and mutually exclusive.
  // Fill rate is measured against every data row, not against the filled
  // subset: a cheque-number column holding one "631" in ten rows is numeric
  // wherever it is filled, and counting only filled cells would rank it as a
  // money column and steal the withdrawal column's role.
  const moneyCols = Array.from({ length: table.numCols }, (_, c) => c).filter((c) =>
    looksLikeMoneyColumn(dataRows.map((row) => row[c] ?? ""), dataRows.length),
  );
  if (moneyCols.length === 0) return null;
  const balanceCol = moneyCols[moneyCols.length - 1];
  roles.set(balanceCol, "balance");
  const amountCols = moneyCols.slice(0, -1);

  if (amountCols.length >= 2) {
    /*
     * Two candidate amount columns are debit and credit even when the header
     * names both ("Withdrawal (Dr)" and "Deposit (Cr)"). Their left-to-right
     * order is not fixed: the same statement prints credit before debit on one
     * page and debit before credit on another. When the header row is really a
     * data row there is nothing to read, so the order decides — and getting it
     * backwards would silently flip every sign on that page.
     */
    for (const col of amountCols) {
      const headerText = (rows[skip - 1]?.[col] ?? "").toLowerCase();
      if (/withdraw|debit|\bdr\b/.test(headerText)) roles.set(col, "withdrawal");
      else if (/deposit|credit|\bcr\b/.test(headerText)) roles.set(col, "deposit");
    }
    const unmapped = amountCols.filter((col) => !roles.has(col));
    if (unmapped.length === 2) {
      roles.set(unmapped[0], "withdrawal");
      roles.set(unmapped[1], "deposit");
    } else if (unmapped.length === 1) {
      // Only one header named a direction; the other column is its counterpart.
      const named = [...roles].find(([col]) => amountCols.includes(col))?.[1];
      roles.set(unmapped[0], named === "withdrawal" ? "deposit" : "withdrawal");
    }
  } else if (amountCols.length === 1) {
    const col = amountCols[0];
    // A single amount column may still be a debit or credit column whose
    // counterpart happened to be empty on every page; trust a named header.
    const headerText = (rows[skip - 1]?.[col] ?? "").toLowerCase();
    if (/withdraw|debit|\bdr\b/.test(headerText)) roles.set(col, "withdrawal");
    else if (/deposit|credit|\bcr\b/.test(headerText)) roles.set(col, "deposit");
    else roles.set(col, "amount");
  } else {
    // No money column passed the fill-rate test.
    return null;
  }

  /*
   * A debit/credit pair where one side is mostly blank: the fill-rate test
   * admits only the busy column, leaving its counterpart unmapped. Pair them
   * when no row fills both — a transaction is a debit or a credit, never both.
   * The header usually names which is which; when it does not (a headerless
   * page), the pair is recorded as ambiguous and the block-level reconciliation
   * settles it by trying both orders.
   */
  const amountRoleCol = [...roles].find(([, role]) =>
    role === "amount" || role === "withdrawal" || role === "deposit",
  )?.[0];
  if (amountRoleCol !== undefined) {
    const numericUnmapped = Array.from({ length: table.numCols }, (_, c) => c).filter(
      (c) =>
        !roles.has(c) &&
        dataRows.filter((row) => (row[c] ?? "").trim()).length >= 2 &&
        dataRows.every((row) => !(row[c] ?? "").trim() || money(row[c] ?? "") !== null),
    );
    const partner = numericUnmapped.find((c) => {
      // Adjacency matters: the debit and credit columns sit side by side, and
      // a mutually-exclusive cheque column further along would otherwise be
      // paired and flip every credit on the page into a withdrawal.
      if (Math.abs(c - amountRoleCol) !== 1) return false;
      const a = dataRows.map((row) => (row[amountRoleCol] ?? "").trim());
      const b = dataRows.map((row) => (row[c] ?? "").trim());
      return a.every((value, index) => !value || !b[index]) && b.filter(Boolean).length >= 2;
    });
    if (partner !== undefined) {
      const named = roles.get(amountRoleCol);
      if (named === "amount") {
        roles.set(amountRoleCol, "withdrawal");
        roles.set(partner, "deposit");
        ambiguousPairs.push([amountRoleCol, partner]);
      } else {
        roles.set(partner, named === "withdrawal" ? "deposit" : "withdrawal");
      }
    }
  }
  // Description: the widest text column that is neither a role nor a serial.
  let descriptionCol = -1;
  let widest = 0;
  for (let c = 0; c < table.numCols; c += 1) {
    if (roles.has(c)) continue;
    const sample = dataRows.map((row) => row[c] ?? "").filter(Boolean);
    if (sample.length === 0) continue;
    const texty = sample.filter((value) => /[A-Za-z]{3}/.test(value)).length;
    const average = sample.reduce((sum, value) => sum + value.length, 0) / sample.length;
    if (texty / sample.length < 0.5) continue;
    if (average > widest) {
      widest = average;
      descriptionCol = c;
    }
  }
  if (descriptionCol >= 0) roles.set(descriptionCol, "description");
  return roles.has(0) || roles.size >= 2 ? roles : null;
}

const SUMMARY_LABELS =
  /^(opening balance|closing balance|brought forward|carried forward|balance b\/?f|balance c\/?f|total|subtotal|legend)/i;

function isSummaryRow(cells: string[]): boolean {
  const joined = cells.filter(Boolean).join(" ").trim();
  if (!joined) return true;
  return SUMMARY_LABELS.test(joined);
}

function cleanDescription(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  // Indian bank narrations append a reference blob: keep the readable head and
  // drop a single 20+ character alphanumeric token, which carries no meaning
  // for the owner but makes every row unreadable.
  const parts = collapsed.split("/");
  const kept: string[] = [];
  for (const part of parts) {
    if (/^[A-Za-z0-9]{20,}$/.test(part.trim())) break;
    kept.push(part);
  }
  const cleaned = kept.join("/").trim();
  return cleaned || collapsed;
}

type RowDraft = {
  rawDate: string;
  description: string;
  rawDescription: string;
  amount: number | null;
  balance: number | null;
};

function readRow(cells: string[], roles: Map<number, ColumnRole>): RowDraft | null {
  let rawDate = "";
  let description = "";
  let withdrawal: number | null = null;
  let deposit: number | null = null;
  let amount: number | null = null;
  let balance: number | null = null;

  for (const [col, role] of roles) {
    const value = cells[col] ?? "";
    switch (role) {
      case "date":
      case "dateOrCheque":
        if (!rawDate && readDate(value)) rawDate = value;
        break;
      case "description":
        description = value;
        break;
      case "withdrawal":
        withdrawal = money(value);
        break;
      case "deposit":
        deposit = money(value);
        break;
      case "amount":
        amount = money(value);
        break;
      case "balance":
        balance = money(value);
        break;
      default:
        break;
    }
  }

  if (!rawDate) return null;
  const signed =
    amount !== null
      ? amount
      : withdrawal !== null && withdrawal !== 0
        ? -Math.abs(withdrawal)
        : deposit !== null && deposit !== 0
          ? Math.abs(deposit)
          : null;
  if (signed === null) return null;

  return {
    rawDate,
    description: cleanDescription(description),
    rawDescription: description,
    amount: signed,
    balance,
  };
}

/** Day-first for a set of raw date strings, decided once per block. */
function dayFirstFor(dateTexts: string[]): boolean {
  return resolveDayFirst([], dateTexts);
}

/** Does this block's own running balance carry forward on every row? */
function blockReconciles(drafts: RowDraft[], dayFirst: boolean): boolean {
  if (drafts.length < 2) return false;
  const ordered = drafts
    .map((draft) => ({ draft, date: isoDate(readDate(draft.rawDate)!, dayFirst) }))
    .filter((entry): entry is typeof entry & { date: string } => entry.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  let previous: number | null = null;
  let checked = 0;
  for (const { draft } of ordered) {
    const balance = draft.balance;
    if (previous !== null && balance !== null) {
      if (Math.abs(previous + (draft.amount ?? 0) - balance) > CENT + 1e-9) return false;
      checked += 1;
    }
    if (balance !== null) previous = balance;
  }
  return checked > 0;
}

/**
 * The account's own name, from the prose above the table. Indian statements
 * state it once in a sentence ("Saving Account no. 537301500429"), never in the
 * table, so without this every export is named "Account" and two statements
 * from the same bank produce indistinguishable files.
 */
function labelFromDocumentText(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(
    /((?:saving|savings|current|checking|deposit|loan|credit)[a-z ]*account[^\n]{0,40}?(?:no\.?|number|#)?\s*[xX*]*\d{3,})/i,
  );
  if (match) return match[1].replace(/\s+/g, " ").trim().slice(0, 120);
  const numbered = text.match(/(account[^\n]{0,30}?(?:no\.?|number|#)\s*[xX*]*\d{3,})/i);
  return numbered ? numbered[1].replace(/\s+/g, " ").trim().slice(0, 120) : null;
}

function accountLabelFrom(rows: string[][], titleRows: number[], headerRow: number): string {  const candidates = [...titleRows.map((r) => rows[r].join(" ")), ...(rows[headerRow] ?? [])];
  for (const text of candidates) {
    const match = text.match(/([A-Za-z ]*account[^\d]*[\d*xX]{2,}[^\s,]*)/i);
    if (match) return match[1].trim().slice(0, 120);
  }
  const titled = candidates.find((text) => /account/i.test(text) && text.trim().length > 0);
  return titled ? titled.trim().slice(0, 120) : "Account";
}

function parseWithFormat(tables: ParsedTable[], statementText?: string): ParseResult {
  type Block = {
    page: number | null;
    accountLabel: string;
    rows: Array<{ draft: RowDraft; position: number }>;
    mapping: MappingReport;
  };

  const blocks: Block[] = [];
  const dateTexts: string[] = [];
  let unsupportedTables = 0;
  /** Keeps positions strictly increasing across table blocks in one document. */
  let tableOffset = 0;

  for (const table of tables) {
    if (table.numRows < 2 || table.numCols < 2) continue;
    const rows = grid(table);
    const flags = headerFlags(table);
    const located = locateHeader(table, rows, flags);
    const ambiguousPairs: Array<[number, number]> = [];

    let roles: Map<number, ColumnRole> | null = null;
    let headerRow = 0;
    let titleRows: number[] = [];
    if (located) {
      roles = located.roles;
      headerRow = located.headerRow;
      titleRows = located.titleRows;
      const hasDate = [...roles.values()].some((r) => r === "date" || r === "dateOrCheque");
      const hasMoney = [...roles.values()].some((r) =>
        r === "amount" || r === "withdrawal" || r === "deposit",
      );
      if (!hasDate || !hasMoney) roles = null;
    }
    if (!roles) {
      roles = inferRoles(table, rows, located ? located.headerRow + 1 : 0, ambiguousPairs);
      if (roles) headerRow = located ? located.headerRow : 0;
    }
    if (!roles) {
      unsupportedTables += 1;
      continue;
    }

    const drafts: RowDraft[] = [];
    const rowIndexes: number[] = [];
    for (let r = headerRow + 1; r < table.numRows; r += 1) {
      const cells = rows[r];
      if (isSummaryRow(cells)) continue;
      const draft = readRow(cells, roles);
      if (draft) {
        // The row index is document-global, not per-block: two tables can hold
        // the same date, and sorting has to restore the statement's own order
        // across the block boundary or the balance chain breaks there.
        drafts.push(draft);
        dateTexts.push(draft.rawDate);
        rowIndexes.push(r);
      }
    }

    /*
     * A debit/credit pair with no header naming its sides is resolved by the
     * reconciliation itself: one of the two assignments carries the balance
     * forward and the other does not. Trying both is cheaper and far more
     * reliable than inferring direction from how often a column is filled.
     */
    for (const [debitCol, creditCol] of ambiguousPairs) {
      const flipped = new Map(roles);
      flipped.set(debitCol, "deposit");
      flipped.set(creditCol, "withdrawal");
      const flippedDrafts = rows
        .slice(headerRow + 1)
        .filter((cells) => !isSummaryRow(cells))
        .map((cells) => readRow(cells, flipped))
        .filter((draft): draft is RowDraft => draft !== null);
      if (flippedDrafts.length !== drafts.length) continue;
      if (blockReconciles(drafts, dayFirstFor(dateTexts)) && !blockReconciles(flippedDrafts, dayFirstFor(dateTexts))) {
        continue;
      }
      if (!blockReconciles(drafts, dayFirstFor(dateTexts)) && blockReconciles(flippedDrafts, dayFirstFor(dateTexts))) {
        for (const [col, role] of flipped) roles.set(col, role);
        drafts.splice(0, drafts.length, ...flippedDrafts);
      }
    }
    if (drafts.length === 0) {
      unsupportedTables += 1;
      continue;
    }
    tableOffset += table.numRows;

    blocks.push({
      page: table.page,
      accountLabel: accountLabelFrom(rows, titleRows, headerRow),
      rows: drafts.map((draft, index) => ({ draft, position: tableOffset + rowIndexes[index] })),
      mapping: {
        page: table.page,
        accountLabel: "",
        header: rows[headerRow] ?? [],
        columns: Object.fromEntries([...roles].map(([col, role]) => [role, col])),
        rowCount: drafts.length,
      },
    });
  }

  if (blocks.length === 0) {
    return {
      status: "unsupported",
      reason: "No table on this document has both a date column and an amount column.",
      tablesSeen: tables.length,
    };
  }

  // Day-first is decided once for the whole document, then applied everywhere.
  const dayFirst = resolveDayFirst([], dateTexts);

  const built: LedgerRow[] = [];
  const mismatches: ReconciliationMismatch[] = [];
  const mappings: MappingReport[] = [];
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let openingBalance: string | null = null;
  let closingBalance: string | null = null;

  // One chain per table block: each block carries its own running balance, and
  // a page that continues the previous one repeats the balance it ended on.
  // Grouping by a label was wrong — statements name an account once and then
  // print pages of unlabelled rows, so the label cannot separate accounts.
  for (const block of blocks) {
    const accountLabel = block.accountLabel;
    let periodFromBlock: string | null = null;
    let periodToBlock: string | null = null;
    /*
     * Ordered within the block, not across blocks. A block is the unit that
     * reconciles: pages carry their own running balance, and a file that holds
     * several accounts (or the same account on non-adjacent pages) has no
     * single chain to walk. Sorting inside the block handles the statements
     * that print newest-first; a misread row still breaks its own block's
     * chain and is still reported.
     */
    let previous: number | null = null;
    const sorted = [...block.rows]
      .map((row) => ({ ...row, date: isoDate(readDate(row.draft.rawDate)!, dayFirst) }))
      .filter((row): row is typeof row & { date: string } => row.date !== null)
      .sort((a, b) => (a.date === b.date ? a.position - b.position : a.date.localeCompare(b.date)));

    sorted.forEach((row, index) => {
      const amount = row.draft.amount ?? 0;
      const balance = row.draft.balance;
      if (previous !== null && balance !== null) {
        const expected = previous + amount;
        if (Math.abs(expected - balance) > CENT + 1e-9) {
          mismatches.push({
            accountLabel,
            position: index,
            occurredOn: row.date,
            description: row.draft.description,
            amount: fixed(amount),
            previousBalance: fixed(previous),
            expectedBalance: fixed(expected),
            actualBalance: fixed(balance),
            difference: fixed(expected - balance),
          });
        }
      }
      if (balance !== null) previous = balance;
      built.push({
        occurredOn: row.date,
        description: row.draft.description,
        rawDescription: row.draft.rawDescription,
        amount: fixed(amount),
        balanceAfter: balance === null ? null : fixed(balance),
        position: built.length,
        accountLabel,
        page: block.page,
      });
    });

    if (sorted.length > 0) {
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const start: string = first.date;
      const end: string = last.date;
      periodFromBlock = start;
      periodToBlock = end;
      const earliest = periodStart as string | null;
      const latest = periodEnd as string | null;
      if (earliest === null || start < earliest) periodStart = start;
      if (latest === null || end > latest) periodEnd = end;
      // The opening balance is the first row's balance minus its own amount;
      // the closing is the last row's balance. Both are derived, never claimed.
      if (first.draft.balance !== null && openingBalance === null) {
        openingBalance = fixed(first.draft.balance - (first.draft.amount ?? 0));
      }
      if (last.draft.balance !== null) closingBalance = fixed(last.draft.balance);
    }
    void periodFromBlock;
    void periodToBlock;

    mappings.push({ ...block.mapping, accountLabel });
  }

  if (built.length === 0) {
    return {
      status: "unsupported",
      reason: "Tables were found but no row held both a readable date and an amount.",
      tablesSeen: tables.length,
    };
  }

  const totals = checkTotals(statementText, built);
  const moneyFormat = activeFormat;
  return {
    status: "parsed",
    rows: built,
    accountLabel: labelFromDocumentText(statementText) ?? [...new Set(blocks.map((block) => block.accountLabel))].join(", "),
    periodStart,
    periodEnd,
    openingBalance,
    closingBalance,
    reconciled: mismatches.length === 0 && totals.status !== "mismatch",
    mismatches,
    totals,
    moneyFormat,
    strategy: "default",
    attempts: [],
    mappings,
    unsupportedTables,
  };
}

const TOTAL_PATTERNS: Array<{ label: string; side: "out" | "in" | "count"; pattern: RegExp }> = [
  {
    label: "total money out",
    side: "out",
    pattern: /total\s+(?:withdrawals?|debits?|paid\s+out|money\s+out)\b[^\d\n]{0,24}([\d][\d.,]*)/gi,
  },
  {
    label: "total money in",
    side: "in",
    pattern: /total\s+(?:deposits?|credits?|paid\s+in|money\s+in)\b[^\d\n]{0,24}([\d][\d.,]*)/gi,
  },
  {
    label: "transaction count",
    side: "count",
    pattern: /(?:total\s+(?:number\s+of\s+)?transactions?|no\.?\s+of\s+transactions?|transactions?\s+count)\b[^\d\n]{0,16}(\d+)\b/gi,
  },
];

/** Compares figures the statement prints about itself with the rows we read. */
export function checkTotals(statementText: string | undefined, rows: LedgerRow[]): TotalsCheck {
  if (!statementText) return { status: "absent", checks: [] };
  const out = rows.filter((row) => Number(row.amount) < 0).reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
  const into = rows.filter((row) => Number(row.amount) > 0).reduce((sum, row) => sum + Number(row.amount), 0);
  const checks: TotalsCheck["checks"] = [];
  let ambiguous = false;
  for (const { label, side, pattern } of TOTAL_PATTERNS) {
    const found = [...statementText.matchAll(pattern)].map((m) => m[1].replace(/[.,]+$/, ""));
    if (found.length === 0) continue;
    if (new Set(found).size > 1) {
      ambiguous = true;
      continue;
    }
    const stated = side === "count" ? Number(found[0]) : money(found[0]);
    if (stated === null || !Number.isFinite(stated)) continue;
    const computed = side === "count" ? rows.length : side === "out" ? out : into;
    const ok = side === "count" ? stated === computed : Math.abs(stated - computed) <= CENT + 1e-9;
    checks.push({
      label,
      stated: side === "count" ? String(stated) : fixed(stated),
      computed: side === "count" ? String(computed) : fixed(computed),
      ok,
    });
  }
  if (checks.length === 0) return { status: ambiguous ? "ambiguous" : "absent", checks };
  return { status: checks.every((c) => c.ok) ? "match" : "mismatch", checks };
}

type Reading = { name: string; format: MoneyFormat | null; dayFirst: boolean | null; spans: boolean };

/**
 * Reconciliation is the router. The default reading goes first. When it does
 * not reconcile, other readings of the same grid are tried, and the first one
 * that carries the running balance forward and agrees with any printed totals
 * wins. A reading is never kept because it looks plausible, only because the
 * bank's own arithmetic accepts it; when none does, the default result is
 * returned unchanged so the owner sees the original, named broken row.
 */
export function parseStatementTables(tables: ParsedTable[], statementText?: string): ParseResult {
  const detected = detectMoneyFormat(tables);
  const readings: Reading[] = [
    { name: "default", format: detected, dayFirst: null, spans: true },
    { name: "month-first dates", format: detected, dayFirst: false, spans: true },
    { name: "without span fill", format: detected, dayFirst: null, spans: false },
    { name: "alternate number format", format: detected === "dot" ? "comma" : "dot", dayFirst: null, spans: true },
  ];

  const attempts: Array<{ strategy: string; reconciled: boolean; mismatches: number; rows: number }> = [];
  let first: ParseResult | null = null;
  for (const reading of readings) {
    const result = runReading(tables, statementText, reading);
    if (result.status !== "parsed") {
      first ??= result;
      continue;
    }
    attempts.push({
      strategy: reading.name,
      reconciled: result.reconciled,
      mismatches: result.mismatches.length,
      rows: result.rows.length,
    });
    if (first === null || first.status !== "parsed") first = result;
    if (result.reconciled) return { ...result, strategy: reading.name, attempts };
  }
  if (first && first.status === "parsed") return { ...first, strategy: "default", attempts };
  return first as ParseResult;
}

function runReading(tables: ParsedTable[], statementText: string | undefined, reading: Reading): ParseResult {
  const previous = { format: activeFormat, dayFirst: activeDayFirst, spans: activeSpans };
  activeFormat = reading.format ?? "dot";
  activeDayFirst = reading.dayFirst;
  activeSpans = reading.spans;
  try {
    return parseWithFormat(tables, statementText);
  } finally {
    activeFormat = previous.format;
    activeDayFirst = previous.dayFirst;
    activeSpans = previous.spans;
  }
}
