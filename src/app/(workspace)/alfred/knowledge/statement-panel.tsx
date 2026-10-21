"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { readStatementLedger } from "./statement-actions";

/*
 * The ledger panel in the document workbench. Two states, and the difference
 * matters to the person reading it: a reconciled statement gets a download; an
 * unreconciled one gets the row that broke the chain and no download, because
 * a CSV whose numbers do not add up is worse than no CSV.
 *
 * A statement that was never read offers "Build ledger" instead, and the panel
 * declines politely when the document has not been read yet.
 */

export type StatementPanelData = {
  status: "parsed" | "needs_review" | "unsupported";
  accountLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  transactionCount: number;
  reconciled: boolean;
  error: string | null;
  mismatches: Array<{
    occurredOn: string;
    description: string;
    amount: string;
    expectedBalance: string;
    actualBalance: string;
  }>;
  rows: Array<{ occurredOn: string; description: string; amount: string }>;
};

function money(value: string | null): string {
  if (value === null) return "—";
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function StatementPanel({
  documentId,
  extractionSucceeded,
  statement,
}: {
  documentId: string;
  extractionSucceeded: boolean;
  statement: StatementPanelData | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  function build() {
    setError(null);
    startTransition(async () => {
      const result = await readStatementLedger(documentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  if (!extractionSucceeded) {
    return (
      <section className="panel rounded-lg px-3.5 py-3">
        <h3 className="text-[13px] font-medium">Statement ledger</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Read the document first. The ledger is built from what the reader found.
        </p>
      </section>
    );
  }

  if (!statement) {
    return (
      <section className="panel rounded-lg px-3.5 py-3">
        <h3 className="text-[13px] font-medium">Statement ledger</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          If this is a bank statement, turn it into a ledger of date, description and amount.
        </p>
        <div className="mt-2">
          <Button type="button" variant="outline" size="sm" onClick={build} disabled={pending}>
            {pending ? "Reading the ledger…" : "Build ledger"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (statement.status === "unsupported") {
    return (
      <section className="panel rounded-lg px-3.5 py-3">
        <h3 className="text-[13px] font-medium">Not a statement</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {statement.error ?? "This document has no table of transactions."}
        </p>
      </section>
    );
  }

  const period =
    statement.periodStart && statement.periodEnd
      ? `${statement.periodStart} to ${statement.periodEnd}`
      : statement.periodStart ?? "period unknown";

  return (
    <section className="panel rounded-lg px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium">Statement ledger</h3>
          <p className="text-muted-foreground mt-1 text-xs">{statement.accountLabel} · {period}</p>
        </div>
        {statement.reconciled ? (
          <a
            href={`/api/v1/documents/${documentId}/statement`}
            className="text-xs underline-offset-4 hover:underline"
            download
          >
            Download CSV
          </a>
        ) : null}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Transactions</dt>
          <dd className="font-medium tabular-nums">{statement.transactionCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Opening</dt>
          <dd className="font-medium tabular-nums">{money(statement.openingBalance)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Closing</dt>
          <dd className="font-medium tabular-nums">{money(statement.closingBalance)}</dd>
        </div>
      </dl>

      {statement.reconciled ? (
        <p className="text-muted-foreground mt-3 text-xs">
          Every row carries the running balance forward. The CSV has three columns:
          date, description, amount — money out is negative.
        </p>
      ) : (
        <div className="mt-3">
          <p role="alert" className="text-destructive text-xs">
            {statement.error ?? "These rows do not reconcile against the statement's running balance."}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            The download stays closed until the rows add up, because a ledger that is
            almost right is a ledger you cannot check.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {statement.mismatches.slice(0, 5).map((mismatch, index) => (
              <li key={`${mismatch.occurredOn}-${index}`} className="text-muted-foreground">
                {mismatch.occurredOn} · {mismatch.description.slice(0, 60)} · {money(mismatch.amount)}
                {" — expected "}
                {money(mismatch.expectedBalance)} but the statement says {money(mismatch.actualBalance)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {statement.rows.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-xs underline-offset-4 hover:underline"
          >
            {expanded ? "Hide rows" : `Show ${statement.rows.length} rows`}
          </button>
          {expanded ? (
            <div className="mt-2 max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground sticky top-0 bg-background text-left">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Date</th>
                    <th className="py-1 pr-2 font-medium">Description</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.map((row, index) => (
                    <tr key={`${row.occurredOn}-${index}`} className="border-border/40 border-t">
                      <td className="py-1 pr-2 whitespace-nowrap tabular-nums">{row.occurredOn}</td>
                      <td className="py-1 pr-2">{row.description.slice(0, 90)}</td>
                      <td className="py-1 text-right tabular-nums">{money(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
