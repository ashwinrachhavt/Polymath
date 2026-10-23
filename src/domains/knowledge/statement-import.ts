import { and, desc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { documentExtractions, documents, files } from "./schema";
import { looksLikeStatement, parseStatementTables, type ParseResult, type ParsedTable } from "./statement-parse";
import { statementImports, statementTransactions } from "./statement-schema";

/*
 * Turning a succeeded extraction into a ledger. Parsing itself is pure (see
 * statement-parse.ts); this module owns the two things that need the database:
 * finding which extraction to read, and recording the result exactly once.
 *
 * An import is keyed by extraction id, so parsing the same extraction twice
 * returns the existing import instead of duplicating rows. Reading the same
 * file with a better mapper produces a new extraction, and therefore a new
 * import — the previous ledger is never rewritten underneath a downloaded CSV.
 */

export type StatementImport = typeof statementImports.$inferSelect;
export type StatementTransaction = typeof statementTransactions.$inferSelect;

export class StatementExtractionMissingError extends Error {
  constructor() {
    super("The document has no successful extraction to read a statement from.");
    this.name = "StatementExtractionMissingError";
  }
}

export class StatementNotParsableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StatementNotParsableError";
  }
}

/** The newest succeeded extraction for a document, workspace-scoped. */
async function latestExtraction(auth: AuthContext, documentId: string) {
  const [row] = await db
    .select({
      id: documentExtractions.id,
      tables: documentExtractions.tables,
      text: documentExtractions.text,
      title: documents.title,
      filename: files.filename,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .leftJoin(files, eq(files.id, documents.fileId))
    .where(
      and(
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documentExtractions.documentId, documentId),
        eq(documentExtractions.status, "succeeded"),
      ),
    )
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function importStatement(
  auth: AuthContext,
  documentId: string,
): Promise<{ import: StatementImport; transactions: StatementTransaction[]; reused: boolean }> {
  const extraction = await latestExtraction(auth, documentId);
  if (!extraction) throw new StatementExtractionMissingError();

  const existing = await loadImport(auth, extraction.id);
  if (existing) return { ...existing, reused: true };

  const tables = (extraction.tables ?? []) as ParsedTable[];
  const parsed: ParseResult = parseStatementTables(tables, extraction.text ?? undefined);

  if (parsed.status === "unsupported") {
    // Recorded, not thrown away: the owner sees why this file is not a
    // statement, and a later attempt against a better extraction can succeed.
    const [row] = await db
      .insert(statementImports)
      .values({
        workspaceId: auth.workspaceId,
        documentId,
        extractionId: extraction.id,
        status: "unsupported",
        accountLabel: "Account",
        transactionCount: 0,
        reconciled: false,
        reconciliation: { mismatches: [], tablesSeen: parsed.tablesSeen },
        mapping: [],
        error: parsed.reason,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: statementImports.extractionId,
        set: { updatedAt: new Date() },
      })
      .returning();
    return { import: row, transactions: [], reused: false };
  }

  const [row] = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(statementImports)
      .values({
        workspaceId: auth.workspaceId,
        documentId,
        extractionId: extraction.id,
        status: parsed.reconciled ? "parsed" : "needs_review",
        accountLabel: parsed.accountLabel,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
        transactionCount: parsed.rows.length,
        reconciled: parsed.reconciled,
        reconciliation: {
          mismatches: parsed.mismatches,
          totals: parsed.totals,
          moneyFormat: parsed.moneyFormat,
          strategy: parsed.strategy,
          attempts: parsed.attempts,
          unsupportedTables: parsed.unsupportedTables,
        },
        mapping: parsed.mappings,
        error: parsed.reconciled
          ? null
          : parsed.mismatches.length > 0
            ? `${parsed.mismatches.length} row${parsed.mismatches.length === 1 ? "" : "s"} do not carry the running balance forward.`
            : `The statement's own totals disagree with the rows read: ${parsed.totals.checks
                .filter((check) => !check.ok)
                .map((check) => `${check.label} says ${check.stated}, rows give ${check.computed}`)
                .join("; ")}.`,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: statementImports.extractionId })
      .returning();

    // Two callers raced; the loser reads the winner's rows rather than writing
    // a second set.
    if (!created) return [null];

    const inserted = await tx
      .insert(statementTransactions)
      .values(
        parsed.rows.map((entry) => ({
          workspaceId: auth.workspaceId,
          importId: created.id,
          accountLabel: entry.accountLabel,
          occurredOn: entry.occurredOn,
          description: entry.description,
          rawDescription: entry.rawDescription,
          amount: entry.amount,
          balanceAfter: entry.balanceAfter,
          position: entry.position,
        })),
      )
      .returning();

    return [created, inserted] as const;
  });

  if (!row) {
    const won = await loadImport(auth, extraction.id);
    if (!won) throw new Error("statement import vanished after a conflicting insert");
    return { ...won, reused: true };
  }

  const transactions = await db
    .select()
    .from(statementTransactions)
    .where(
      and(
        eq(statementTransactions.workspaceId, auth.workspaceId),
        eq(statementTransactions.importId, row.id),
      ),
    )
    .orderBy(statementTransactions.position);

  return { import: row, transactions, reused: false };
}

async function loadImport(
  auth: AuthContext,
  extractionId: string,
): Promise<{ import: StatementImport; transactions: StatementTransaction[] } | null> {
  const [row] = await db
    .select()
    .from(statementImports)
    .where(
      and(
        eq(statementImports.workspaceId, auth.workspaceId),
        eq(statementImports.extractionId, extractionId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const transactions = await db
    .select()
    .from(statementTransactions)
    .where(
      and(
        eq(statementTransactions.workspaceId, auth.workspaceId),
        eq(statementTransactions.importId, row.id),
      ),
    )
    .orderBy(statementTransactions.position);
  return { import: row, transactions };
}

/** The newest import for a document, for the review screen. */
export async function statementForDocument(
  auth: AuthContext,
  documentId: string,
): Promise<{ import: StatementImport; transactions: StatementTransaction[] } | null> {
  const [row] = await db
    .select()
    .from(statementImports)
    .where(
      and(
        eq(statementImports.workspaceId, auth.workspaceId),
        eq(statementImports.documentId, documentId),
      ),
    )
    .orderBy(desc(statementImports.createdAt))
    .limit(1);
  if (!row) return null;
  const transactions = await db
    .select()
    .from(statementTransactions)
    .where(
      and(
        eq(statementTransactions.workspaceId, auth.workspaceId),
        eq(statementTransactions.importId, row.id),
      ),
    )
    .orderBy(statementTransactions.position);
  return { import: row, transactions };
}


/**
 * Read a statement ledger without anyone asking, when the document reads like
 * a bank statement. Called at the end of extraction so an upload of a
 * statement is detected and parsed on its own (ASH-202). The text predicate
 * is the cheap gate; the parser remains the authority and records
 * "unsupported" when the tables do not yield a ledger. Import is idempotent
 * per extraction, so a retry of extraction simply reuses the ledger it made.
 */
export async function maybeImportStatement(
  auth: AuthContext,
  documentId: string,
): Promise<{ attempted: boolean; status?: StatementImport["status"] }> {
  const extraction = await latestExtraction(auth, documentId);
  if (!extraction) return { attempted: false };
  if (!looksLikeStatement(extraction.text ?? "", extraction.filename ?? extraction.title)) {
    return { attempted: false };
  }
  const result = await importStatement(auth, documentId);
  return { attempted: true, status: result.import.status };
}

export type StatementStatus = {
  extraction: "none" | "pending" | "failed" | "succeeded" | "skipped";
  looksLikeStatement: boolean;
  import: {
    status: StatementImport["status"];
    reconciled: boolean;
    accountLabel: string;
    periodStart: string | null;
    periodEnd: string | null;
    transactionCount: number;
    error: string | null;
  } | null;
};

/**
 * What the vault viewer needs to render the statement strip: has the document
 * been read, does it read like a statement, and where does its ledger stand.
 * Transactions stay out of this shape; the review workbench queries them
 * itself.
 */
export async function statementStatus(auth: AuthContext, documentId: string): Promise<StatementStatus> {
  const [latest] = await db
    .select({
      status: documentExtractions.status,
      text: documentExtractions.text,
      title: documents.title,
      filename: files.filename,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .leftJoin(files, eq(files.id, documents.fileId))
    .where(
      and(
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documentExtractions.documentId, documentId),
      ),
    )
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);

  const found = await statementForDocument(auth, documentId);
  if (found) {
    return {
      extraction: latest?.status ?? "none",
      looksLikeStatement: true,
      import: {
        status: found.import.status,
        reconciled: found.import.reconciled,
        accountLabel: found.import.accountLabel,
        periodStart: found.import.periodStart,
        periodEnd: found.import.periodEnd,
        transactionCount: found.import.transactionCount,
        error: found.import.error,
      },
    };
  }
  if (!latest || latest.status !== "succeeded") {
    return { extraction: latest?.status ?? "none", looksLikeStatement: false, import: null };
  }
  return {
    extraction: "succeeded",
    looksLikeStatement: looksLikeStatement(latest.text ?? "", latest.filename ?? latest.title),
    import: null,
  };
}