import Link from "next/link";
import { Empty, Panel } from "@/components/workspace/ui";
import { getUsageLedger } from "@/domains/agents/queries";
import { getAuthContext } from "@/lib/auth";

const WINDOW_DAYS = 7;

function money(usd: string | null): string {
  if (usd === null) return "unpriced";
  return `$${usd}`;
}

function tokens(row: { inputTokens: number; outputTokens: number }): string {
  return `${(row.inputTokens + row.outputTokens).toLocaleString("en-US")} tokens`;
}

/*
 * The canonical spending ledger, restored as a Briefing tab (the IA plan's
 * destination for /command-center/spending). Real accounting only: one row
 * per run with recorded usage events, summed in SQL by the same derivation
 * the run page shows. The recording contract is named on the surface - a
 * step may report usage without a price, so unpriced work is shown as
 * "unpriced", never as zero, and nothing here claims to be a complete bill.
 */
export async function SpendingPanel() {
  const auth = await getAuthContext();
  const ledger = await getUsageLedger(auth.workspaceId, WINDOW_DAYS);

  return (
    <>
      {/* The mockup's stat strip: the week in three numbers, unpriced named
          not zeroed. */}
      <div className="panel mb-6 grid grid-cols-1 overflow-hidden rounded-xl sm:grid-cols-3">
        <div className="flex flex-col gap-1 border-border p-5 max-sm:border-b sm:not-last:border-r">
          <span className="stat-label">This week</span>
          <span className="text-2xl font-semibold tabular-nums">
            {ledger.totalUsd !== null ? `$${ledger.totalUsd}` : "—"}
          </span>
          <span className="text-[12px] text-muted-foreground">Derived from the ledger rows below.</span>
        </div>
        <div className="flex flex-col gap-1 border-border p-5 max-sm:border-b sm:not-last:border-r">
          <span className="stat-label">Runs recorded</span>
          <span className="text-2xl font-semibold tabular-nums">{ledger.rows.length}</span>
          <span className="text-[12px] text-muted-foreground">
            {ledger.unpricedRuns > 0
              ? `${ledger.unpricedRuns} with usage but no recorded price.`
              : "Every priced usage event."}
          </span>
        </div>
        <div className="flex flex-col gap-1 border-border p-5">
          <span className="stat-label">Unpriced</span>
          <span className="text-2xl font-semibold tabular-nums">
            {ledger.unpricedRuns > 0 ? ledger.unpricedRuns : "—"}
          </span>
          <span className="text-[12px] text-muted-foreground">Unpriced work shows as unpriced, never as zero.</span>
        </div>
      </div>

      <Panel
        title="Ledger"
        description={`Recorded agent usage for the last ${WINDOW_DAYS} days. A step can report usage without a price, so unpriced work is named, and these are recorded figures, not a guaranteed complete bill.`}
      >
        {ledger.rows.length === 0 ? (
          <Empty
            title="No recorded usage"
            description={`No agent runs recorded usage in the last ${WINDOW_DAYS} days.`}
          />
        ) : (
          <div className="divide-y divide-border">
            {ledger.rows.map((row) => (
              <div key={row.runId} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0">
                <div className="min-w-0">
                  <Link href={`/alfred/${row.runId}`} className="block truncate text-[13px] font-medium hover:underline">
                    {row.objective}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.state.replaceAll("_", " ")}
                    {row.startedAt ? ` · ${row.startedAt.toISOString().slice(0, 10)}` : ""} · {tokens(row)}
                  </p>
                </div>
                <span className={`text-[13px] tabular-nums ${row.usd === null ? "text-muted-foreground" : ""}`}>
                  {money(row.usd)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
