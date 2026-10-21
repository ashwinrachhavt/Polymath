import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";
import { documents, documentExtractions } from "./schema";

/*
 * The ledger read out of one statement document. An import is keyed by the
 * extraction it came from, so re-reading the same file with a better mapper
 * produces a new import instead of editing one the owner may already have
 * downloaded. Nothing here is derived at read time: the rows are the record.
 */

export const statementImportStatus = pgEnum("statement_import_status", [
  "parsed",
  "needs_review",
  "unsupported",
]);

export const statementImports = pgTable(
  "statement_imports",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => documentExtractions.id, { onDelete: "cascade" }),
    status: statementImportStatus("status").notNull(),
    /** Account as the statement names it; "Account" when it names none. */
    accountLabel: text("account_label").notNull(),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 }),
    closingBalance: numeric("closing_balance", { precision: 18, scale: 2 }),
    transactionCount: integer("transaction_count").notNull().default(0),
    /*
     * The accuracy claim, stored rather than recomputed: every row carried the
     * running balance forward to the cent. An unreconciled import is still
     * readable and still reviewable — it is only the export that refuses.
     */
    reconciled: boolean("reconciled").notNull().default(false),
    /** Per-block verdicts and the row that broke the chain. */
    reconciliation: jsonb("reconciliation").notNull().default({}),
    /** The header row and column mapping each table block was read with. */
    mapping: jsonb("mapping").notNull().default([]),
    /** Why the statement could not be read, in words the owner can act on. */
    error: text("error"),
    ...mutable,
  },
  (t) => [
    // One import per extraction: re-parsing is a new row, never an edit.
    uniqueIndex("statement_imports_extraction_key").on(t.extractionId),
    index("statement_imports_document_idx").on(t.workspaceId, t.documentId, t.createdAt),
  ],
);

export const statementTransactions = pgTable(
  "statement_transactions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    importId: uuid("import_id")
      .notNull()
      .references(() => statementImports.id, { onDelete: "cascade" }),
    accountLabel: text("account_label").notNull(),
    occurredOn: date("occurred_on").notNull(),
    description: text("description").notNull(),
    /** The untrimmed narration, kept so cleaning is never a silent loss. */
    rawDescription: text("raw_description").notNull(),
    /*
     * Signed: money out is negative, money in is positive. One summable
     * column is the whole point of the CSV, so the sign carries direction
     * rather than a separate debit/credit pair.
     */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    balanceAfter: numeric("balance_after", { precision: 18, scale: 2 }),
    /** Position within the account chain, after chronological ordering. */
    position: integer("position").notNull(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("statement_transactions_position_key").on(t.importId, t.position),
    index("statement_transactions_ledger_idx").on(t.workspaceId, t.accountLabel, t.occurredOn),
    // A zero-amount transaction is not a transaction; it is a parse error.
    check("statement_transactions_amount_nonzero", sql`amount <> 0`),
  ],
);

/*
 * An owner's correction, remembered. "QWZX TRADING is education" is stored once
 * under the merchant key (see transaction-classify.ts) and applies to every
 * later statement, so the review queue shrinks as the owner works through it.
 * The category is text validated at the edge against the taxonomy, so adding a
 * category never needs a migration.
 */
export const transactionCategoryRules = pgTable(
  "transaction_category_rules",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    merchantKey: text("merchant_key").notNull(),
    category: text("category").notNull(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("transaction_category_rules_key").on(t.workspaceId, t.merchantKey),
    check("transaction_category_rules_key_nonempty", sql`length(merchant_key) > 0`),
  ],
);
