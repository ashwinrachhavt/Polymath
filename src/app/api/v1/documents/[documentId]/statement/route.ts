import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { buildClassifiedLedgerCsv, buildLedgerCsv, ledgerCsvFilename } from "@/domains/knowledge/statement-csv";
import { statementForDocument } from "@/domains/knowledge/statement-import";

/*
 * GET /api/v1/documents/:documentId/statement.csv — the ledger for one
 * statement document, as a downloadable file.
 *
 * An unreconciled import is refused rather than served. A CSV whose rows do
 * not carry the bank's own running balance forward is a file the owner cannot
 * check, and once it is in a spreadsheet the error is invisible. 409 names the
 * row that broke the chain so the download can be retried after a correction.
 */
export const GET = authedHandler(async (auth, request, ctx: { params: Promise<{ documentId: string }> }) => {
  requireRole(auth, "viewer");
  const { documentId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) {
    return problemResponse(404, "not_found", "No such document in this workspace.");
  }

  const found = await statementForDocument(auth, documentId);
  if (!found) {
    return problemResponse(404, "not_found", "No statement has been read from this document.");
  }
  if (found.import.status === "unsupported") {
    return problemResponse(
      409,
      "not_a_statement",
      found.import.error ?? "This document is not a statement.",
    );
  }
  if (!found.import.reconciled) {
    const mismatches = (found.import.reconciliation as { mismatches?: Array<{ occurredOn: string; description: string }> })
      .mismatches;
    const first = mismatches?.[0];
    return problemResponse(
      409,
      "not_reconciled",
      first
        ? `The row on ${first.occurredOn} (${first.description}) does not carry the balance forward. Correct it before exporting.`
        : "This statement's rows do not reconcile against its running balance.",
    );
  }

  // ?categories=1 adds a local category per row. The default stays three columns.
  const withCategories = new URL(request.url).searchParams.get("categories") === "1";
  const csv = withCategories ? buildClassifiedLedgerCsv(found.transactions) : buildLedgerCsv(found.transactions);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ledgerCsvFilename(found.import.accountLabel, found.import.periodStart, found.import.periodEnd)}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
