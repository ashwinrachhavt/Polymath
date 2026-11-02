/*
 * The close rule for a run's open reservation (PR-5, Pino's settle-at-estimate
 * call): unknown cost is never zero. Pure on purpose — callers hand in the
 * SQL-aggregated facts, so every branch is testable without a database.
 *
 * Precedence at close:
 *   1. no usage events at all          → 0, state `confirmed-zero`
 *   2. any unpriced usage event        → the reservation estimate, state `estimated`
 *   3. every usage event priced        → the priced sum, state `priced`
 *
 * Branch 2 is the locked decision: the estimate was sized for the whole run
 * before it started, so unpriced usage settles the whole run at it — never a
 * silent zero, and the reservation never just stays open hoping for a price.
 */

/** The headline state a settlement's figure carries in its `usage` jsonb. */
export type SettlementState = "priced" | "estimated" | "confirmed-zero";

export interface CloseUsageFacts {
  /** All `usage` events the run recorded, priced or not. */
  usageEvents: number;
  /** Events carrying a resolved figure (provider-reported, estimated, confirmed-zero, reconciled). */
  pricedEvents: number;
  /** Sum of the priced events' figures, as a numeric string. */
  pricedUsd: string;
  /** The open reservation's estimate — the settlement for unpriced usage. */
  reservedUsd: string;
}

export interface SettlementDecision {
  /** The dollar figure to settle, as a numeric string. */
  actualUsd: string;
  /** What the figure is: priced actuals, the reservation estimate, or a known zero. */
  state: SettlementState;
}

export function decideSettlement(facts: CloseUsageFacts): SettlementDecision {
  // No usage events is an observation, not a gap: nothing was consumed, so
  // zero is known whether or not a rate card exists.
  if (facts.usageEvents === 0) return { actualUsd: "0.000000", state: "confirmed-zero" };

  if (facts.pricedEvents < facts.usageEvents) {
    return { actualUsd: facts.reservedUsd, state: "estimated" };
  }

  return { actualUsd: facts.pricedUsd, state: "priced" };
}
