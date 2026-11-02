/*
 * Backfill pricing stamps on historical usage events (PR-8). Every usage
 * event recorded before PR-4's priced ingestion carries no `data.pricing`
 * stamp; this script re-prices those rows through the PR-4 resolver with the
 * rate card effective at each event's own timestamp, so the spending panel's
 * history reads the same five states new events do. Run manually, after the
 * release's migrations are applied — there is no cron; backfill is an
 * operator action, not a background job.
 *
 * Idempotent by construction: a candidate is a usage event without a stamp,
 * and the write is guarded on that same predicate. A second pass plans zero
 * events and writes zero rows — run it twice and compare; the convergence is
 * the verification.
 *
 *   pnpm backfill:usage-pricing                      # dry run, report only
 *   pnpm backfill:usage-pricing -- --apply           # write the stamps
 *   pnpm backfill:usage-pricing -- --workspace <id>  # scope to one workspace
 *
 * Requires the rate-card validity migration (0272) and, for real history,
 * rate cards whose effective_from covers the events' era — a card that did
 * not exist at the event's timestamp is honestly reported unpriced, never
 * priced from the future.
 */
import type { AuthContext } from "@/domains/identity/resolve";
import { getSpendingOverview } from "@/domains/spending/queries";
import {
  backfillUsagePricing,
  summarizeUsageEventPricing,
  workspacesWithUsageEvents,
  type UsagePricingSummary,
  type UsageBackfillReport,
} from "@/domains/spending/backfill";
import type { PricingState } from "@/domains/spending/pricing";

function stateLine(mix: Record<PricingState, number>): string {
  const entries = Object.entries(mix) as Array<[PricingState, number]>;
  const named = entries.filter(([, n]) => n > 0).map(([state, n]) => `${state} ${n}`);
  return named.length > 0 ? named.join(", ") : "none";
}

function printSummary(title: string, summary: UsagePricingSummary): void {
  console.log(`${title}`);
  console.log(
    `  usage events ${summary.usageEvents} | priced ${summary.pricedEvents} | unpriced ${summary.unpricedEvents}`,
  );
  console.log(`  states: ${stateLine(summary.states)}`);
  console.log(`  priced total: ${summary.pricedUsd} USD`);
}

function printReport(report: UsageBackfillReport): void {
  const mode = report.apply ? "apply" : "dry run";
  console.log(`usage-pricing backfill (${mode})`);
  console.log(
    `  candidates ${report.candidates} | ${report.apply ? `written ${report.written}` : "would stamp (no writes)"} | unprocessable ${report.unprocessable}`,
  );
  console.log(`  planned states: ${stateLine(report.planned)}`);
  console.log(`  planned priced total: ${report.plannedUsd} USD`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const workspaceFlag = process.argv.indexOf("--workspace");
  const workspaceId = workspaceFlag >= 0 ? process.argv[workspaceFlag + 1] : undefined;

  const report = await backfillUsagePricing({ apply, workspaceId });
  printReport(report);

  for (const workspace of await workspacesWithUsageEvents(workspaceId)) {
    const summary = await summarizeUsageEventPricing(workspace);
    printSummary(`workspace ${workspace} — usage events, same derivation as the ledger`, summary);
    // The panel's own figures (reservations + settlements), printed beside the
    // event mix so the operator reconciles against getSpendingOverview directly.
    const overview = await getSpendingOverview({ workspaceId: workspace } as AuthContext);
    console.log(
      `  panel (getSpendingOverview): settledToday ${overview.settledToday} | settledThisMonth ${overview.settledThisMonth} | openReservedToday ${overview.openReservedToday} | rateCards ${overview.rateCards.length}`,
    );
  }

  printSummary(
    apply
      ? "final reconciliation (all usage events in scope)"
      : "reconciliation as it stands (dry run — pass --apply to write)",
    await summarizeUsageEventPricing(workspaceId),
  );
  if (apply) {
    console.log("re-run this command: it must report 0 candidates and write 0 rows — that is the idempotency proof.");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
