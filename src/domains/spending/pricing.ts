/*
 * The pricing resolver: turns a usage event's token counts into a dollar
 * figure and a pricing state. Pure on purpose — no db import, no clock, no
 * env. The callers (event-bridge ingestion, the history backfill) resolve the
 * rate card and pass it in; every decision this module makes is testable
 * without a database.
 *
 * Money is never a JS float. Rates arrive as `numeric(12,6)` strings from
 * Postgres, and the arithmetic below runs on BigInt scaled to 10^-12 USD —
 * one rate (6 decimals of a dollar per million tokens) times one token count
 * is exact, and only the final rounding to the cent-scale columns rounds at
 * all (half-up, as a ledger should).
 */

/** The five states a priced usage event can carry. */
export type PricingState = "provider-reported" | "estimated" | "confirmed-zero" | "unpriced" | "reconciled";

/**
 * The slice of a `model_rate_cards` row the resolver prices from. Rates are
 * USD per million tokens as decimal strings (drizzle returns `numeric` as
 * string); a null cache rate means cache tokens price at the input rate.
 */
export interface RateCardRates {
  id: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cacheReadPerMillion: string | null;
  cacheWritePerMillion: string | null;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingInput {
  provider: string;
  model: string;
  tokens: UsageTokens;
  /** Gateway/provider-reported cost, when one exists. Absent everywhere today. */
  reportedCostUsd?: string | null;
  /** The card effective at the event's timestamp, or null when none is. */
  rateCard?: RateCardRates | null;
}

/** What ingestion stamps into `event.data.pricing`. */
export interface PricedUsage {
  usd: string | null;
  state: PricingState;
  rateCardId?: string;
}

const ZERO_USD = "0.000000";

/*
 * BigInt via the constructor, not literals: the repo's tsconfig targets below
 * ES2020, where `1n` literals are a type error. Same values, same arithmetic.
 */
const MICROS_PER_USD = BigInt(1_000_000);
const HALF_MICRO = BigInt(500_000);

/*
 * The resolver never returns "reconciled": that state is written only by the
 * manual reconciliation flow, marking a figure a human set against an invoice.
 * A resolver-computed value that overrode a human's reconciliation would be a
 * regression wearing a state name. The type keeps "reconciled" so storage and
 * display can carry it without a second union.
 */

/**
 * Resolves one usage event's price.
 *
 * Precedence: provider-reported > estimated (rate card) > confirmed-zero (no
 * tokens) > unpriced (tokens, no card). "reconciled" is reserved for manual
 * writes and never returned here.
 */
export function resolvePricing(input: PricingInput): PricedUsage {
  const reported = input.reportedCostUsd;
  if (typeof reported === "string" && reported.trim() !== "") {
    return { usd: reported, state: "provider-reported" };
  }

  const totalTokens = input.tokens.input + input.tokens.output + input.tokens.cacheRead + input.tokens.cacheWrite;

  // Zero tokens is an observation, not an estimate: nothing was consumed, so
  // the cost is known to be zero whether or not a card exists. A card's
  // presence cannot make a known zero more known.
  if (totalTokens === 0) {
    return { usd: ZERO_USD, state: "confirmed-zero" };
  }

  if (input.rateCard) {
    const usd = priceFromCard(input.rateCard, input.tokens);
    if (usd !== null) {
      return { usd, state: "estimated", rateCardId: input.rateCard.id };
    }
    // An unparseable rate on a looked-up card is corrupt operator data —
    // surface it as unpriced rather than guessing at a number. Callers log.
  }

  return { usd: null, state: "unpriced" };
}

/**
 * Rates are `numeric(12,6)` — at most six decimals, never negative. Returns
 * the rate scaled to integer micro-dollars-per-million-tokens, or null when
 * the string does not have that shape.
 */
export function rateToMicroPerMillion(rate: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if (!match) return null;
  const [whole, decimals = ""] = [match[1] ?? "", match[2] ?? ""];
  const scaled = `${whole}${decimals}${"0".repeat(6 - decimals.length)}`;
  return BigInt(scaled);
}

/**
 * The cost of a token count under a card, as a six-decimal USD string.
 * Cache tokens fall back to the input rate when the card has no cache rate.
 * Returns null when any needed rate is unparseable — callers treat the card
 * as unusable rather than pricing from a guessed number.
 */
function priceFromCard(card: RateCardRates, tokens: UsageTokens): string | null {
  const inputRate = rateToMicroPerMillion(card.inputPerMillion);
  const outputRate = rateToMicroPerMillion(card.outputPerMillion);
  if (inputRate === null || outputRate === null) return null;
  const cacheReadRate = card.cacheReadPerMillion === null ? inputRate : rateToMicroPerMillion(card.cacheReadPerMillion);
  const cacheWriteRate =
    card.cacheWritePerMillion === null ? inputRate : rateToMicroPerMillion(card.cacheWritePerMillion);
  if (cacheReadRate === null || cacheWriteRate === null) return null;

  // Units: tokens × (micro-USD per million tokens) = 10^-12 USD.
  const total =
    BigInt(tokens.input) * inputRate +
    BigInt(tokens.output) * outputRate +
    BigInt(tokens.cacheRead) * cacheReadRate +
    BigInt(tokens.cacheWrite) * cacheWriteRate;

  // Round half-up to micro-USD, the scale every money column holds.
  const micros = (total + HALF_MICRO) / MICROS_PER_USD;
  return formatMicroUsd(micros);
}

/** Integer micro-USD → "12.345678" (no sign: counts and rates are non-negative). */
function formatMicroUsd(micros: bigint): string {
  const whole = micros / MICROS_PER_USD;
  const frac = micros % MICROS_PER_USD;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

/*
 * eve's usage payload shape (`step.completed`): token counts as integers and
 * an optional gateway cost. Everything is optional and hostile input is
 * possible — an extraction that cannot trust a field prices it as zero, and
 * an unparseable reported cost is treated as absent so the resolver falls
 * through to the rate card. This is the boundary where the external event
 * shape is parsed into the domain's types.
 */

const countFrom = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
};

/** Extracts token counts from a raw usage payload; untrusted fields price as zero. */
export function tokensFromUsage(usage: Record<string, unknown>): UsageTokens {
  return {
    input: countFrom(usage["inputTokens"]),
    output: countFrom(usage["outputTokens"]),
    cacheRead: countFrom(usage["cacheReadTokens"]),
    cacheWrite: countFrom(usage["cacheWriteTokens"]),
  };
}

/**
 * Extracts a provider-reported cost as a decimal string, or null when absent
 * or malformed. A negative value is not a cost — treated as absent rather
 * than credited.
 */
export function reportedCostFromUsage(usage: Record<string, unknown>): string | null {
  const value = usage["costUsd"];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return value;
  return null;
}
