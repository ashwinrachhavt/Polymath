import { and, asc, eq, sql } from "drizzle-orm";
import { pricedFigure } from "@/domains/agents/queries";
import { providerForModel } from "@/domains/agents/models";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { db } from "@/lib/db";
import {
  reportedCostFromUsage,
  resolvePricing,
  tokensFromUsage,
  type PricedUsage,
  type PricingState,
  type RateCardRates,
} from "./pricing";
import { findEffectiveRateCard } from "./queries";

/*
 * The history backfill (PR-8). PR-4 taught ingestion to price every new usage
 * event at the moment it lands; events recorded before it shipped carry no
 * pricing stamp, so the ledger reads them as unpriced however much money the
 * payload represents. This module re-prices those rows through the same
 * resolver, with the card effective at each event's own timestamp, and is
 * what the manual script runs:
 *
 *   pnpm backfill:usage-pricing              # dry run, report only
 *   pnpm backfill:usage-pricing -- --apply   # write stamps
 *
 * Idempotency is structural, not bookkeeping: a candidate is a usage event
 * with no pricing stamp, and the stamp write is guarded on that same
 * predicate — a second pass finds nothing to do and writes zero rows.
 * Stamping what the resolver answers, even when the answer is `unpriced`, is
 * what makes that convergence hold; the ledger reads an explicit unpriced
 * stamp exactly like a missing one (no figure either way). Rows already
 * stamped keep the first price they got — the same rule ingestion's replay
 * dedup enforces.
 */

/** A usage event lacking a pricing stamp — the backfill's candidate. */
export interface BackfillCandidate {
  id: string;
  workspaceId: string;
  /** The event payload; the bridge stores objects, null predates its contract. */
  data: Record<string, unknown> | null;
  /** The event's own instant — the card effective here is the card that prices it. */
  createdAt: Date;
  /** The run's frozen model, when its row still names one. */
  model: string | null;
}

/**
 * The card a candidate prices from. Pure over the map it is handed; the
 * orchestration binds it to `findEffectiveRateCard`, the same lookup
 * ingestion uses — the backfill must never grow a second half-open-interval
 * rule that can disagree with the panel.
 */
export type BackfillCardLookup = (
  workspaceId: string,
  provider: string,
  model: string,
  at: Date,
) => Promise<RateCardRates | null>;

export interface UsagePricingDecision {
  id: string;
  workspaceId: string;
  /** What the resolver answered for this event, at its own timestamp. */
  pricing: PricedUsage;
}

/**
 * Pure over its inputs (no clock, no env): plans the stamp for each candidate
 * by resolving its catalog provider, looking up the card effective at the
 * event's timestamp, and handing both to the PR-4 resolver. Callers get back
 * exactly what ingestion would have stamped had this row landed after PR-4.
 */
export async function planUsagePricingStamps(
  candidates: BackfillCandidate[],
  cardAt: BackfillCardLookup,
): Promise<UsagePricingDecision[]> {
  const decisions: UsagePricingDecision[] = [];
  for (const candidate of candidates) {
    // An out-of-catalog or unfrozen model has no catalog provider, so no card
    // can be effective — the same answer ingestion's priceUsage reaches
    // before it ever queries one.
    const provider = providerForModel(candidate.model ?? "");
    const card = provider
      ? await cardAt(candidate.workspaceId, provider, candidate.model ?? "", candidate.createdAt)
      : null;
    decisions.push({
      id: candidate.id,
      workspaceId: candidate.workspaceId,
      // The resolver reads neither string today; they ride along so a future
      // caller cannot mis-key a lookup through these decisions.
      pricing: resolvePricing({
        provider: provider ?? "unknown",
        model: candidate.model ?? "unknown",
        tokens: tokensFromUsage(candidate.data ?? {}),
        reportedCostUsd: reportedCostFromUsage(candidate.data ?? {}),
        rateCard: card,
      }),
    });
  }
  return decisions;
}

export interface UsageBackfillReport {
  apply: boolean;
  /** Candidates the planner priced. */
  candidates: number;
  /** Rows actually stamped: 0 on a dry run and on a converged re-run. */
  written: number;
  /** Usage events whose data jsonb is not an object — named, never written. */
  unprocessable: number;
  /** State mix of the planned stamps, keyed by resolver state. */
  planned: Record<PricingState, number>;
  /** Sum of the planned figures (nulls add nothing), 6-decimal text. */
  plannedUsd: string;
}

const emptyStateMix = (): Record<PricingState, number> => ({
  "provider-reported": 0,
  estimated: 0,
  "confirmed-zero": 0,
  unpriced: 0,
  reconciled: 0,
});

/*
 * Money arithmetic for the report only — the ledger's figures come from SQL
 * numeric sums. Computed at a 10^-9 scale (the resolver's own figures carry
 * six decimals; a gateway-reported cost may carry more) and rounded half-up
 * to the six-decimal shape every money column holds, so a dry run's planned
 * total reads the same shape the post-apply summary prints.
 */
const REPORT_SCALE = 9;

function usdToUnits(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) return null;
  const [whole, decimals = ""] = [match[1] ?? "", match[2] ?? ""];
  return BigInt(`${whole}${decimals}${"0".repeat(REPORT_SCALE - decimals.length)}`);
}

/** Exact decimal-string sum of six-decimal USD figures; garbage strings price as zero but never throw. */
export function sumUsd(values: string[]): string {
  let total = BigInt(0);
  for (const value of values) {
    const units = usdToUnits(value);
    if (units !== null) total += units;
  }
  const micros = (total + BigInt(500)) / BigInt(1000); // half-up to 10^-6
  const whole = micros / BigInt(1_000_000);
  const frac = micros % BigInt(1_000_000);
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

async function fetchCandidateBatch(
  cursor: string | null,
  limit: number,
  workspaceId: string | undefined,
): Promise<BackfillCandidate[]> {
  const rows = await db
    .select({
      id: runEvents.id,
      workspaceId: runEvents.workspaceId,
      data: runEvents.data,
      createdAt: runEvents.createdAt,
      model: agentRuns.model,
    })
    .from(runEvents)
    .leftJoin(agentRuns, eq(agentRuns.id, runEvents.runId))
    .where(
      and(
        eq(runEvents.type, "usage"),
        // A scalar jsonb payload would make jsonb_set fail mid-run; named in
        // the report's unprocessable count instead of writing anything.
        sql`(${runEvents.data} is null or jsonb_typeof(${runEvents.data}) = 'object')`,
        sql`(${runEvents.data} -> 'pricing') is null`,
        workspaceId ? eq(runEvents.workspaceId, workspaceId) : undefined,
        cursor ? sql`${runEvents.id} > ${cursor}` : undefined,
      ),
    )
    .orderBy(asc(runEvents.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, data: (row.data ?? null) as Record<string, unknown> | null }));
}

/**
 * Stamps one event's `data.pricing`, guarded on the same no-stamp predicate
 * that selected it — a row priced between the scan and the write matches no
 * row, so a concurrent ingestion or a racing second pass can never double
 * write. Returns whether this call landed the stamp.
 */
async function stampUsageEvent(id: string, pricing: PricedUsage): Promise<boolean> {
  const rows = (await db.execute(sql`
    update run_events
    set data = jsonb_set(coalesce(data, '{}'::jsonb), '{pricing}', ${JSON.stringify(pricing)}::jsonb, true)
    where id = ${id} and type = 'usage'
      and (data is null or jsonb_typeof(data) = 'object')
      and (data -> 'pricing') is null
    returning id
  `)) as unknown as { id: string }[];
  return rows.length > 0;
}

async function countUnprocessable(workspaceId: string | undefined): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n
    from run_events
    where type = 'usage' and data is not null and jsonb_typeof(data) <> 'object'
      ${workspaceId ? sql`and workspace_id = ${workspaceId}` : sql``}
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Workspaces holding usage events, so the report can reconcile per tenant. */
export async function workspacesWithUsageEvents(workspaceId: string | undefined): Promise<string[]> {
  const rows = (await db.execute(sql`
    select distinct workspace_id from run_events where type = 'usage'
      ${workspaceId ? sql`and workspace_id = ${workspaceId}` : sql``}
  `)) as unknown as { workspace_id: string }[];
  return rows.map((row) => row.workspace_id);
}

export type UsagePricingSummary = {
  usageEvents: number;
  pricedEvents: number;
  /** Events with no figure anywhere — no stamp figure and no raw costUsd. */
  unpricedEvents: number;
  /** Per-event state mix, exactly the ledger's derivation. */
  states: Record<PricingState, number>;
  /** Sum of priced figures as numeric text; "0" when nothing is priced. */
  pricedUsd: string;
};

/**
 * The reconciliation summary: every usage event in scope, priced and unpriced
 * counts, and the per-event state mix — aggregated with the ledger's own
 * `pricedFigure` fragment, the predicate getUsageLedger feeds the spending
 * panel, so the script's printed summary and the panel can only ever agree.
 */
export async function summarizeUsageEventPricing(workspaceId: string | undefined): Promise<UsagePricingSummary> {
  const scope = workspaceId ? sql` and e.workspace_id = ${workspaceId}` : sql``;
  const rows = (await db.execute(sql`
    select
      count(*)::int as usage_events,
      count(${pricedFigure})::int as priced_events,
      coalesce(sum(${pricedFigure}), 0)::text as priced_usd,
      coalesce(sum(case when e.data->'pricing'->>'state' = 'provider-reported' then 1 else 0 end), 0)::int as state_provider_reported,
      coalesce(sum(case when e.data->'pricing'->>'state' = 'estimated' then 1 else 0 end), 0)::int as state_estimated,
      coalesce(sum(case when e.data->'pricing'->>'state' = 'confirmed-zero' then 1 else 0 end), 0)::int as state_confirmed_zero,
      coalesce(sum(case when e.data->'pricing'->>'state' = 'reconciled' then 1 else 0 end), 0)::int as state_reconciled
    from run_events e
    where e.type = 'usage'${scope}
  `)) as unknown as {
    usage_events: number;
    priced_events: number;
    priced_usd: string;
    state_provider_reported: number;
    state_estimated: number;
    state_confirmed_zero: number;
    state_reconciled: number;
  }[];

  const row = rows[0];
  const usageEvents = row?.usage_events ?? 0;
  const pricedEvents = row?.priced_events ?? 0;
  return {
    usageEvents,
    pricedEvents,
    unpricedEvents: usageEvents - pricedEvents,
    states: {
      "provider-reported": row?.state_provider_reported ?? 0,
      estimated: row?.state_estimated ?? 0,
      "confirmed-zero": row?.state_confirmed_zero ?? 0,
      unpriced: usageEvents - pricedEvents,
      reconciled: row?.state_reconciled ?? 0,
    },
    pricedUsd: row?.priced_usd ?? "0",
  };
}

/**
 * Walks every usage event without a pricing stamp in id keyset batches and
 * stamps each with the resolver's answer at the event's own timestamp. A dry
 * run (apply: false) plans and reports without writing; apply writes through
 * the guard in stampUsageEvent, so an interrupted or doubled run converges —
 * a second pass finds zero candidates and writes zero rows.
 */
export async function backfillUsagePricing(options: {
  apply: boolean;
  batchSize?: number;
  workspaceId?: string;
  onBatch?: (progress: { scanned: number; written: number }) => void;
}): Promise<UsageBackfillReport> {
  const batchSize = options.batchSize ?? 200;
  const planned = emptyStateMix();
  const plannedUsd: string[] = [];
  let candidates = 0;
  let written = 0;
  let cursor: string | null = null;

  for (;;) {
    const batch = await fetchCandidateBatch(cursor, batchSize, options.workspaceId);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]?.id ?? cursor;
    const decisions = await planUsagePricingStamps(batch, findEffectiveRateCard);
    for (const decision of decisions) {
      candidates += 1;
      planned[decision.pricing.state] += 1;
      if (decision.pricing.usd !== null) plannedUsd.push(decision.pricing.usd);
      if (options.apply && (await stampUsageEvent(decision.id, decision.pricing))) written += 1;
    }
    options.onBatch?.({ scanned: candidates, written });
  }

  return {
    apply: options.apply,
    candidates,
    written,
    unprocessable: await countUnprocessable(options.workspaceId),
    planned,
    plannedUsd: sumUsd(plannedUsd),
  };
}
