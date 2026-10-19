import { connection } from "next/server";
import { Suspense } from "react";
import { Empty, Panel, Screen, Stat, Status } from "@/components/workspace/ui";
import { getSpendingOverview } from "@/domains/spending/queries";
import { getAuthContext } from "@/lib/auth";
import { PolicyForm, RateCardForm } from "./spending-forms";

export const metadata = { title: "Spending · Axiom" };

/*
 * Canonical spending surface (ASH-139 C06): the reserve/settle engine state
 * made visible - policy, today's claimed and settled totals, open
 * reservations, the settlement ledger and rate cards, all derived from
 * Postgres at render. No synthetic cost entries: an empty ledger renders as
 * empty, and missing rates stay missing (the engine fails closed on them).
 */

function usd(value: string | null): string {
  if (value == null) return "—";
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return value;
  return `$${asNumber.toFixed(2)}`;
}

async function Spending() {
  await connection();
  const auth = await getAuthContext();
  const overview = await getSpendingOverview(auth);

  return (
    <Screen
      title="Spending"
      description="Real accounting for paid agent work: a budget is reserved before a run spends and settled from provider usage after. Nothing here estimates or invents costs."
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Reserved today" value={usd(overview.openReservedToday)} hint="Open claims against the budget" />
        <Stat label="Settled today" value={usd(overview.settledToday)} hint="Actual spend, from settlements" />
        <Stat label="Settled this month" value={usd(overview.settledThisMonth)} />
        <Stat
          label="Remaining today"
          value={overview.remainingToday != null ? usd(overview.remainingToday) : "—"}
          hint={overview.policy?.dailyCeilingUsd ? `of ${usd(overview.policy.dailyCeilingUsd)} daily ceiling` : "No daily ceiling set"}
        />
      </div>

      <Panel
        title="Spending policy"
        description="The ceilings the reserve path enforces. Leave a field empty for no ceiling; empty is not zero - zero would block every run."
      >
        <PolicyForm
          policy={
            overview.policy
              ? {
                  dailyCeilingUsd: overview.policy.dailyCeilingUsd,
                  monthlyCeilingUsd: overview.policy.monthlyCeilingUsd,
                  perRunCeilingUsd: overview.policy.perRunCeilingUsd,
                  onExceeded: overview.policy.onExceeded,
                  version: overview.policy.version,
                }
              : null
          }
        />
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Open reservations" description="Money claimed by runs that have not settled.">
          <div className="divide-y divide-border">
            {overview.openReservations.map((reservation) => (
              <div key={reservation.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                <div>
                  <p className="text-[13px] font-medium">{usd(reservation.reservedUsd)}</p>
                  <p className="text-xs text-muted-foreground">
                    {reservation.model || "Model not recorded"} · {reservation.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z
                  </p>
                </div>
                <Status>{reservation.status}</Status>
              </div>
            ))}
          </div>
          {!overview.openReservations.length ? (
            <Empty title="No open reservations" description="A reservation appears when a run starts paid work." />
          ) : null}
        </Panel>

        <Panel title="Recent settlements" description="The append-only ledger of actual spend.">
          <div className="divide-y divide-border">
            {overview.recentSettlements.map((settlement) => (
              <div key={settlement.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                <p className="text-[13px] font-medium">{usd(settlement.amountUsd)}</p>
                <p className="text-xs text-muted-foreground">
                  {settlement.model || "Model not recorded"} · {settlement.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z
                </p>
              </div>
            ))}
          </div>
          {!overview.recentSettlements.length ? (
            <Empty title="No settlements yet" description="A settlement lands when a run's provider usage is reconciled." />
          ) : null}
        </Panel>
      </div>

      <Panel
        title="Rate cards"
        description="Each card prices one model; a price change is a new card with a later effective time, never an edit, so past runs keep the price that was active when they ran. A model with no card cannot be reserved - missing rates fail closed."
      >
        <div className="mb-4 divide-y divide-border">
          {overview.rateCards.map((card) => (
            <div key={card.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-[13px] font-medium">
                  {card.provider}/{card.model}
                </p>
                <p className="text-xs text-muted-foreground">
                  in ${card.inputPerMillion} · out ${card.outputPerMillion} per M tokens
                </p>
              </div>
              <Status>from {card.effectiveFrom.toISOString().slice(0, 10)}</Status>
            </div>
          ))}
        </div>
        {!overview.rateCards.length ? (
          <div className="mb-4">
            <Empty
              title="No rate cards"
              description="Add the exact price from the provider's verified pricing page. Do not guess rates."
            />
          </div>
        ) : null}
        <RateCardForm />
      </Panel>
    </Screen>
  );
}

export default function SpendingPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading spending…</p>}>
      <Spending />
    </Suspense>
  );
}
