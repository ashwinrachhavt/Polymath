import { describe, expect, it } from "vitest";
import { Later } from "@/domains/superagent/effects/later";
import {
  EFFECT_BACKOFF,
  REPLY_BACKOFF,
  backoffCurveFor,
  backoffMs,
  effectBackoffMs,
} from "@/domains/superagent/effects/backoff";

/*
 * The retry curves and the Later defer, pure: every draw is injected, so each
 * bound is asserted exactly rather than statistically. The curves are the
 * spec's named numbers — everything but reply doubles 2s → 60s, reply goes
 * 5s → 300s — so a drift here is a spec regression, not a tuning change.
 */

describe("Later", () => {
  it("carries the retry delay and reason as an Error subclass", () => {
    const later = new Later(5_000, "another pass is sending this conversation");
    expect(later).toBeInstanceOf(Error);
    expect(later.retryAfterMs).toBe(5_000);
    expect(later.reason).toBe("another pass is sending this conversation");
    expect(later.name).toBe("Later");
  });

  it("serializes to a readable message", () => {
    expect(new Later(1_500).message).toContain("1500ms");
    expect(new Later(1_500, "parked").message).toContain("parked");
  });
});

describe("backoffMs", () => {
  it("spans [base, base*2) at full jitter on the first attempt", () => {
    expect(backoffMs(EFFECT_BACKOFF, 1, () => 0)).toBe(2_000);
    expect(backoffMs(EFFECT_BACKOFF, 1, () => 0.5)).toBe(3_000);
    expect(backoffMs(EFFECT_BACKOFF, 1, () => 0.999)).toBeCloseTo(3_998, 0);
  });

  it("doubles the base per attempt: 2, 4, 8, 16, 32, 60 — then holds", () => {
    // random()=0 isolates the base; the doubling is the spec's curve.
    expect(backoffMs(EFFECT_BACKOFF, 1, () => 0)).toBe(2_000);
    expect(backoffMs(EFFECT_BACKOFF, 2, () => 0)).toBe(4_000);
    expect(backoffMs(EFFECT_BACKOFF, 3, () => 0)).toBe(8_000);
    expect(backoffMs(EFFECT_BACKOFF, 4, () => 0)).toBe(16_000);
    expect(backoffMs(EFFECT_BACKOFF, 5, () => 0)).toBe(32_000);
    expect(backoffMs(EFFECT_BACKOFF, 6, () => 0)).toBe(60_000);
    // The cap holds forever: attempt 40 is still 60s.
    expect(backoffMs(EFFECT_BACKOFF, 40, () => 0)).toBe(60_000);
    // And the jitter never lifts a capped row past the cap.
    expect(backoffMs(EFFECT_BACKOFF, 6, () => 1)).toBe(60_000);
  });

  it("clamps nonsense attempt counts to the first attempt", () => {
    expect(backoffMs(EFFECT_BACKOFF, 0, () => 0)).toBe(2_000);
    expect(backoffMs(EFFECT_BACKOFF, -3, () => 0)).toBe(2_000);
  });

  it("the reply curve doubles 5s → 300s and holds", () => {
    expect(backoffMs(REPLY_BACKOFF, 1, () => 0)).toBe(5_000);
    expect(backoffMs(REPLY_BACKOFF, 2, () => 0)).toBe(10_000);
    expect(backoffMs(REPLY_BACKOFF, 3, () => 0)).toBe(20_000);
    expect(backoffMs(REPLY_BACKOFF, 4, () => 0)).toBe(40_000);
    expect(backoffMs(REPLY_BACKOFF, 5, () => 0)).toBe(80_000);
    expect(backoffMs(REPLY_BACKOFF, 6, () => 0)).toBe(160_000);
    // 5 * 2^6 = 320s is past the cap; the curve holds at 300s.
    expect(backoffMs(REPLY_BACKOFF, 7, () => 0)).toBe(300_000);
    expect(backoffMs(REPLY_BACKOFF, 99, () => 0.999)).toBe(300_000);
  });
});

describe("effectBackoffMs", () => {
  it("routes the reply kind to the reply curve and everything else to the default", () => {
    expect(backoffCurveFor("reply")).toBe(REPLY_BACKOFF);
    for (const kind of ["assessment", "launch", "delivery", "relay", "notice"] as const) {
      expect(backoffCurveFor(kind)).toBe(EFFECT_BACKOFF);
    }
    expect(effectBackoffMs("reply", 1, () => 0)).toBe(5_000);
    expect(effectBackoffMs("launch", 1, () => 0)).toBe(2_000);
  });
});
