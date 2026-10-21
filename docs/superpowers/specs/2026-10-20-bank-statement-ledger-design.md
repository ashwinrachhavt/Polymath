# Bank statement to ledger CSV

**Status:** design, awaiting review
**Date:** 2026-10-20

## Problem

A statement PDF is a picture of a ledger. Turning it back into a ledger by hand
is slow enough that it does not happen, and typing it into a spreadsheet by eye
introduces exactly the errors the exercise is supposed to remove.

The owner wants one artefact: a CSV of date, description, amount that opens in a
spreadsheet and can be summed. The reader is a parent doing their own
bookkeeping, so a row that silently misreads is worse than no row at all — they
have no way to tell which numbers to distrust.

**Success:** every transaction on the statement appears in the CSV once, in the
right direction, and the read is provably complete because the statement's own
running balance reconciles to the cent.

## What already exists

This feature is a consumer of the document pipeline, not a parallel one.

| Piece | Where | State |
|---|---|---|
| Upload → blob → file → document → extraction outbox | `src/app/api/v1/files/route.ts`, `src/domains/knowledge/intake.ts` | works |
| Durable extraction with leases, retries, content-hash versioning | `src/domains/knowledge/extraction.ts` | works |
| Local Docling adapter | `src/integrations/extraction/docling-docker.ts` | works, but asks for markdown only |
| Library / inbox UI | `src/app/(workspace)/alfred/knowledge/` | works |

Six real statements were uploaded through this path while this design was
written and are now extracted in the `ashwinr@vt.edu` workspace under the
`Statements` folder.

## Evidence the approach works

Docling's JSON output gives every table cell a row index, a column index, and a
`column_header` flag. Rebuilding the grid from those coordinates and reconciling
against the running balance was tested against the real corpus:

| Statement | Layout quirks | Rows | Reconciliation mismatches |
|---|---|---|---|
| ICICI Savings Aug 2026 | two date-column variants across pages (6-col and 7-col), header repeated per page | 75 | 0 |
| ICICI Current Aug 2026 | data present in the header row, 8 columns, cheque column sometimes empty | 36 | 0 |
| SoFi Jan 2026 | newest-first ordering, two accounts in one file | 10 | 0 |
| SoFi Dec 2025 | newest-first ordering, three account blocks | 12 | 0 |

`prev_balance + amount == balance` holds within one cent for every transaction.
That is the correctness gate: a misread amount, a dropped row, a doubled row, or
a wrong sign all break the chain and are reported as such.

Loan Labs pay stubs were in the same batch and are **not** statements. They must
be detected as unsupported rather than forced into the ledger shape.

## Approaches rejected

- **LLM extraction.** Non-deterministic and it cannot be checked — a model that
  is right 98% of the time produces a file where the wrong 2% is invisible.
- **Markdown table parsing.** Docling's markdown loses the cell grid; merged
  headers and wrapped description lines produce silently shifted columns.

## Design

### Pipeline

```
upload (existing)
  → extractDocument (existing, gains JSON table output)
  → parseStatement (new, pure)
  → reconcile (new, pure)
  → persistence (new table)
  → review screen (new)
  → CSV (new route)
```

Parsing and reconciliation are pure functions over Docling's table JSON. They
take no database handle, make no network call, and are tested against saved
fixtures from the real corpus (sanitised: account numbers and balances are
personal data and the fixtures are never committed — see Testing).

### 1. Docling adapter returns tables

`src/integrations/extraction/docling-docker.ts` asks for `to_formats=md` today.
It gains `to_formats=json` and maps `json_content.tables` into a narrow shape
that is ours, not Docling's:

```ts
export type ParsedTable = {
  page: number | null;
  numRows: number;
  numCols: number;
  cells: Array<{ row: number; col: number; text: string; header: boolean; rowSpan: number; colSpan: number }>;
};
```

Docling's own types never travel past the adapter. A change in its schema is a
change in one file.

### 2. Column mapping, per table block

The same document can change its column layout between pages: the ICICI savings
statement is 6 columns on pages 1 and 5 and 7 on pages 2 to 4 because "Transaction
Date" and "Cheque Number" are merged on some pages and separate on others. A
single document-wide header row would misalign two thirds of the rows.

So each table block is classified and mapped independently:

1. **Classify.** A block is a transaction table when its header row names a date
   column and at least one amount-ish column, or when it has ≥3 columns and ≥2
   data rows whose cells parse as a date and a money value. Tables that classify
   as neither are ignored (the SoFi "Participating banks" blocks).
2. **Locate the header.** The header is the first row whose cells carry
   `column_header: true`, but a header row may also sit below a title row
   (`Savings Account - 3030`) or be missing entirely (`ICICI Current`, where the
   first data row carries the header flags). When the flags are absent, fall back
   to asking which row makes the columns parse.
3. **Map columns** by header text, with a synonym list:
   - date: `date`, `transaction date`, `posting date`, `txn date`
   - description: `description`, `transaction remarks`, `particulars`, `details`, `narration`, `memo`
   - amount out: `withdrawal`, `debit`, `dr`, `paid out`, `money out`
   - amount in: `deposit`, `credit`, `cr`, `paid in`, `money in`
   - amount (signed): `amount`, `transaction amount`
   - balance: `balance`, `running balance`, `available balance`, `closing balance`
4. **Refuse when unmapped.** A block that has a date but no recognisable amount
   column, or an amount but no date, is reported as unsupported with the header
   row quoted back. It is never guessed at.

### 3. Row extraction

- **Direction.** Two-column layouts (`Withdrawal` / `Deposit`) produce a signed
  amount: withdrawal negative, deposit positive. A single `Amount` column is
  taken as already signed. A `Dr`/`Cr` suffix on a single column supplies the sign.
- **Dates.** `DD.MM.YYYY`, `DD-Mon-YYYY` (Docling inserts a space: `03-Aug- 2026`),
  `DD-MM-YYYY`, `Mon DD, YYYY`, `YYYY-MM-DD`. Ambiguous forms resolve on the
  document: if any date has a first component above 12, the file is day-first.
  A file that stays ambiguous is reported, not assumed.
- **Money.** Strip currency symbols and thousands separators; parentheses mean
  negative; a trailing `Dr`/`Cr` is a sign, not part of the number. Values are
  kept as strings until the numeric column, then stored as `numeric(18,2)`.
- **Description.** Trimmed, interior whitespace collapsed. The email/UPI stamp
  tail that Indian banks append (`.../UPI/AXIS BANK/621302007132/ICI...`) is cut
  at the transaction reference when a stable marker precedes it, keeping the
  human-identifiable head (`PATHAN BAB`). The untrimmed text is retained in a
  separate column so nothing is lost.
- **Ignored rows.** Summary rows, "Brought forward", "Carried forward",
  opening/closing balance rows, and total rows are recognised by having no date,
  a label from a known list, or no amount, and are excluded from the ledger.

### 4. Reconciliation

The gate, and the reason this feature can claim accuracy.

Per account block:

1. Sort by date; a stable sort preserves statement order within a day.
2. For each consecutive pair, assert `balance[n-1] + amount[n] == balance[n]`
   within a one-cent tolerance.
3. The result is `reconciled` only when every pair passes.

A failure reports the offending row's date, description, amount, expected
balance, and actual balance, plus the difference. It is a first-class state, not
an error toast: the review screen shows it, and export is disabled with the
reason attached.

Two layout facts the reconciliation must respect, both learned from the corpus:

- **Order is not chronological.** SoFi prints newest first. Sorting before
  reconciling is required, and is what turned 9 apparent mismatches into 0.
- **Multiple accounts per file.** SoFi interleaves a checking and a savings
  account. Chains are built per account label and never across them.

### 5. Persistence

Two tables, one migration.

```sql
statement_imports (
  id uuid pk, workspace_id, document_id, extraction_id,
  status text,            -- parsed | needs_review | unsupported | failed
  account_label text,
  period_start date, period_end date,
  opening_balance numeric(18,2), closing_balance numeric(18,2),
  transaction_count integer,
  reconciled boolean not null default false,
  reconciliation jsonb,   -- per-block verdicts, mismatch detail
  mapping jsonb,          -- the header row and column mapping used per block
  error text,
  ...recorded
)

statement_transactions (
  id uuid pk, workspace_id, import_id, document_id,
  account_label text,
  occurred_on date not null,
  description text not null,
  raw_description text not null,
  amount numeric(18,2) not null,
  balance_after numeric(18,2),
  position integer not null,
  ...recorded
)
```

Invariants in the database: `amount <> 0`, unique `(import_id, position)`, index
on `(workspace_id, account_label, occurred_on)`.

`statement_imports` is keyed by `(document_id, extraction_id)` so a re-extraction
produces a new import rather than editing one that was reviewed.

### 6. Review surface

One screen: `/alfred/knowledge/documents/[documentId]/statement`.

It shows the verdict first, because that is the question being asked:

- account label, period, transaction count
- opening and closing balance, and whether they match the statement's stated totals
- **reconciled / not reconciled**, with the mismatching row named when not
- the parsed rows in a table, with the signed amount
- a download button, disabled with the reason when unreconciled
- "This is not a statement" for the unsupported case, with the detected tables quoted

A statement that fails reconciliation is editable at the row level — the owner
corrects the amount or date, and the chain re-runs. Manual correction is the
escape hatch, and it is visible as a correction rather than silently rewriting
the parse.

### 7. CSV export

`GET /api/v1/documents/[documentId]/statement.csv`

- Columns: `Date,Description,Amount`. Signed — money out negative, money in
  positive. One summable column.
- Date as `YYYY-MM-DD` (sortable, unambiguous).
- Amount with two decimals, no thousands separator, no currency symbol.
- UTF-8 with BOM so Excel opens it correctly on every platform.
- RFC 4180 quoting: descriptions contain commas.
- Refuses with `409` and a problem-detail body naming the mismatch when the
  import is not reconciled.
- Served as an attachment with a filename derived from the account label and period.

## Out of scope

- Categories, tax classification, ledger accounts, double-entry.
- Merging multiple statements into one file — each document exports its own.
- Bank API integrations; only PDF in.
- Multi-currency conversion. Currency is recorded, never converted.
- The hosted providers (Reducto, LlamaParse) returning tables — local Docling
  only, because the JSON table path is what this depends on. A hosted fallback
  yields unsupported, not a wrong answer.

## Testing

- **Fixture tests** (unit, no database): saved Docling `tables` JSON per layout
  quirk — merged date/cheque column, data-in-header-row, newest-first, multi-account.
  Fixtures are **sanitised**: account numbers, names, and balances replaced with
  synthetic values of the same shape. Real statement content is never committed.
- **Reconciliation tests**: a dropped row, a doubled row, a flipped sign, and a
  one-cent drift each must produce a reported mismatch naming the right row.
- **Integration test** against real Postgres: parsing a document twice does not
  duplicate transactions; a re-extraction creates a new import rather than
  mutating a reviewed one; a query from another workspace returns nothing.
- **Route test**: CSV is refused for an unreconciled import; a reconciled one is
  byte-identical across two requests.

## Known gaps carried in

- The outbox dispatcher starves low-priority rows: 112 pending events, mostly
  handlerless note topics that each wait 60 seconds, mean an uploaded statement's
  `document.extraction_requested` sits behind them. Extraction was run directly
  while writing this. Fixing the starvation is a separate change; until it is
  fixed, statement uploads should be extracted from the document screen rather
  than waiting for the queue.
- Statements larger than the 25 MB upload limit are rejected at intake.
