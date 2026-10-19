import { describe, expect, it } from "vitest";
import { backoffMs, OUTBOX_MAX_ATTEMPTS } from "@/domains/audit/outbox";

describe("backoffMs", () => {
  it("grows exponentially and stays under the attempt ceiling", () => {
    const highs = [1, 2, 3, 4].map((attempt) => backoffMs(attempt, () => 0.9999));
    expect(highs[0]).toBeLessThanOrEqual(1000);
    expect(highs[1]).toBeLessThanOrEqual(2000);
    expect(highs[2]).toBeLessThanOrEqual(4000);
    expect(highs[3]).toBeLessThanOrEqual(8000);
    expect(highs[1]).toBeGreaterThan(highs[0]);
  });

  it("caps at one minute however large the attempt", () => {
    expect(backoffMs(20, () => 0.9999)).toBeLessThanOrEqual(60_000);
  });

  it("jitters down to zero", () => {
    expect(backoffMs(3, () => 0)).toBe(0);
  });
});

describe("OUTBOX_MAX_ATTEMPTS", () => {
  it("is a small bounded number", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(OUTBOX_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
