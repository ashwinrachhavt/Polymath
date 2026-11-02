import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Empty, Panel, StatStrip } from "@/components/workspace/ui";
import { displayTitle } from "@/lib/display-text";
import { stripMentionContext } from "@/components/chat/mention-context";
import { getUsageLedger, type RunPricingState, type UsageLedgerRow } from "@/domains/agents/queries";
import { getSpendingOverview } from "@/domains/spending/queries";
import { getAuthContext } from "@/lib/auth";
import { dateKeyInTimezone } from "@/lib/local-date";

const WINDOW_DAYS = 7;

/*
 * numeric-string money for display, formatted without ever passing the sum
 * through a JS float: keep every digit Postgres produced, trim trailing
 * zeros, pad to cents. "0.5500" reads as "$0.55"; "0.0000015" keeps its
 * digits instead of rounding to "$0.0000".
 */
function money(usd: string | null): string {
  if (usd === null) return "—";
  const [whole, frac = ""] = usd.split(".");
  let decimals = frac.replace(/0+$/, "");
  if (decimals.length < 2) decimals = decimals.padEnd(2, "0");
  return `$${whole}.${decimals}`;
}

/*
 * The ledger badge for a run's pricing summary (RunPricingState). Settled
 * states read as settled; the gaps read as gaps — outline, with the priced
 * share on `partial`.
 */
const PRICING_BADGE: Record<RunPricingState, { label: string; variant: "secondary" | "outline" }> = {
  "provider-reported": { label: "provider-reported", variant: "secondary" },
  estimated: { label: "estimated", variant: "secondary" },
  "confirmed-zero": { label: "confirmed-zero", variant: "secondary" },
  reconciled: { label: "reconciled", variant: "secondary" },
  priced: { label: "priced", variant: "secondary" },
  partial: { label: "partial", variant: "outline" },
  unpriced: { label: "unpriced", variant: "outline" },
};

/** Input, output, and cache tokens as separate numbers — never one blended total. */
function tokens(row: UsageLedgerRow): string {
  const parts = [`${row.inputTokens.toLocaleString("en-US")} in`, `${row.outputTokens.toLocaleString("en-US")} out`];
  const cache = row.cacheReadTokens + row.cacheWriteTokens;
  if (cache > 0) parts.push(`${cache.toLocaleString("en-US")} cache`);
  return parts.join(" · ");
}

/*
 * The canonical spending ledger (/command-center/spending). Real accounting
 * only: one row per run with recorded usage events, summed in SQL by the
 * same derivation the run page shows, with headline totals aggregated over
 * the whole window in SQL - never the sum of the visible page. Period
 * actuals (settled today / this month) come from the accounting surface
 * (getSpendingOverview), which owns the local-timezone day bounds; the
 * ledger's headline is the raw recorded-usage window. The recording
 * contract is named on the surface - a step may report usage without a
 * price, so unpriced work is shown per run as a badge, never as zero, and
 * nothing here claims to be a complete bill.
 */
export async function SpendingPanel() {
  const auth = await getAuthContext();
  const [ledger, overview] = await Promise.all([
    getUsageLedger(auth.workspaceId, WINDOW_DAYS),
    getSpendingOverview(auth),
  ]);

  return (
    <>
      <StatStrip
        className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
        items={[
          {
            label: `Last ${WINDOW_DAYS} days`,
            value: money(ledger.totalUsd),
            hint: "Recorded usage across the whole window, not just the rows below.",
          },
          {
            label: "Settled today",
            value: money(overview.settledToday),
            hint: "Actual spend settled against reservations today, in the workspace's timezone.",
          },
          {
            label: "Settled this month",
            value: money(overview.settledThisMonth),
            hint: "Calendar month to date, in the workspace's timezone.",
          },
          {
            label: "Unpriced runs",
            value: ledger.unpricedRuns > 0 ? ledger.unpricedRuns : "—",
            hint: "Runs with usage but no recorded price, window-wide. Unpriced work shows as unpriced, never as zero.",
          },
        ]}
      />

      <Panel
        title="Ledger"
        description={`Recorded agent usage for the last ${WINDOW_DAYS} days. ${
          ledger.runCount > ledger.rows.length
            ? `${ledger.runCount} runs have usage in the window; showing the ${ledger.rows.length} most recent. `
            : ""
        }A step can report usage without a price, so unpriced work is named, and these are recorded figures, not a guaranteed complete bill.`}
      >
        {ledger.rows.length === 0 ? (
          <Empty
            title="No recorded usage"
            description={`No agent runs recorded usage in the last ${WINDOW_DAYS} days.`}
          />
        ) : (
          <div className="divide-y divide-border">
            {ledger.rows.map((row) => {
              const badge = PRICING_BADGE[row.pricingState];
              return (
                <div key={row.runId} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0">
                  <div className="min-w-0">
                    <Link
                      href={`/polymath/${row.runId}`}
                      className="block truncate text-[13px] font-medium hover:underline"
                    >
                      {displayTitle(stripMentionContext(row.objective)) || "Untitled run"}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.state.replaceAll("_", " ")}
                      {/* The run's local day in the workspace's timezone — the same
                          clock the settled-period bounds use — never a UTC slice. */}
                      {row.startedAt ? ` · ${dateKeyInTimezone(row.startedAt, overview.timezone)}` : ""} · {tokens(row)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`text-[13px] tabular-nums ${row.usd === null ? "text-muted-foreground" : ""}`}>
                      {money(row.usd)}
                    </span>
                    <Badge variant={badge.variant}>
                      {row.pricingState === "partial"
                        ? `partial · ${row.pricedEvents}/${row.usageEvents} priced`
                        : badge.label}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
