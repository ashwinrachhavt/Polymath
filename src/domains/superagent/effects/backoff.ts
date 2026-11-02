/** Per-kind retry curves for the effects queue: base doubling with full jitter, capped per kind. */
import type { EffectKind } from "../store/schema";

type BackoffCurve = { baseMs: number; capMs: number };

/** Every kind but `reply`: doubles from 2s and stops growing at 60s. */
export const EFFECT_BACKOFF: BackoffCurve = { baseMs: 2_000, capMs: 60_000 };
/** `reply`: delivery to a person's conversation backs off gently, from 5s up to a five-minute ceiling. */
export const REPLY_BACKOFF: BackoffCurve = { baseMs: 5_000, capMs: 300_000 };

/**
 * Full jitter over a doubling base: failure n (counted from the first) draws
 * uniformly from [base * 2^(n - 1), min(cap, base * 2^n)) — the curve doubles
 * per attempt and the draw never lands below the current step. Jitter keeps a
 * burst of failing effects from re-aligning on one clock; the ceiling stops
 * the growth so a persistently failing kind retries at the cap until a person
 * intervenes. The draw is injected so tests pin the schedule exactly.
 */
export function backoffMs(
  curve: BackoffCurve,
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const failures = Math.max(1, consecutiveFailures);
  const step = curve.baseMs * 2 ** (failures - 1);
  const low = Math.min(curve.capMs, step);
  const high = Math.min(curve.capMs, step * 2);
  return Math.floor(low + random() * (high - low));
}

/** The curve an effect's kind follows. */
export function backoffCurveFor(kind: EffectKind): BackoffCurve {
  return kind === "reply" ? REPLY_BACKOFF : EFFECT_BACKOFF;
}

/** The delay before an effect's next attempt after `consecutiveFailures` consecutive real failures. */
export function effectBackoffMs(
  kind: EffectKind,
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  return backoffMs(backoffCurveFor(kind), consecutiveFailures, random);
}
