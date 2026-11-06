import { describe, expect, it } from "vitest";
// The extension ships plain scripts; the fail-safe is exported for Node.
import Focus from "../../extensions/chrome/focus-core.js";

const T0 = 1_760_000_000_000;

describe("focus poll staleness fail-safe", () => {
  it("keeps rules while the last successful poll is inside the stale window", () => {
    expect(Focus.failSafeDecision({ lastOkAt: T0 }, T0 + 1)).toBe("keep");
    expect(Focus.failSafeDecision({ lastOkAt: T0 }, T0 + Focus.STALE_AFTER_MS - 1)).toBe("keep");
  });

  it("clears rules after 10 minutes of failures — an outage must never lock a user out", () => {
    expect(Focus.failSafeDecision({ lastOkAt: T0 }, T0 + Focus.STALE_AFTER_MS + 1)).toBe("clear");
    expect(Focus.failSafeDecision({ lastOkAt: T0 }, T0 + 2 * Focus.STALE_AFTER_MS)).toBe("clear");
  });

  it("holds the boundary: a full 10 minutes is still tolerated, a second more is not", () => {
    expect(Focus.failSafeDecision({ lastOkAt: T0 }, T0 + Focus.STALE_AFTER_MS)).toBe("keep");
  });

  it("clears when the cache is missing or corrupt — rules without a timestamp prove nothing", () => {
    expect(Focus.failSafeDecision(null, T0)).toBe("clear");
    expect(Focus.failSafeDecision(undefined, T0)).toBe("clear");
    expect(Focus.failSafeDecision({}, T0)).toBe("clear");
    expect(Focus.failSafeDecision({ lastOkAt: 0 }, T0)).toBe("clear");
    expect(Focus.failSafeDecision({ lastOkAt: "yesterday" }, T0)).toBe("clear");
  });

  it("keeps rules when the clock looks backwards (skew never triggers the fail-safe)", () => {
    expect(Focus.failSafeDecision({ lastOkAt: T0 + 60_000 }, T0)).toBe("keep");
  });
});

describe("poll failure decision", () => {
  it("a 403 is forbidden immediately — a key without focus:read never recovers by retrying", () => {
    expect(Focus.pollFailureDecision(403, { lastOkAt: T0 }, T0 + 1)).toBe("forbidden");
    // Even a fresh successful-poll cache does not ride the stale window.
    expect(Focus.pollFailureDecision(403, { lastOkAt: T0 }, T0)).toBe("forbidden");
    // Nor does an absent cache (the never-worked case: blocking silently off).
    expect(Focus.pollFailureDecision(403, null, T0)).toBe("forbidden");
  });

  it("non-403 failures fall through to the stale fail-safe", () => {
    expect(Focus.pollFailureDecision(undefined, { lastOkAt: T0 }, T0 + 1)).toBe("keep");
    expect(Focus.pollFailureDecision(500, { lastOkAt: T0 }, T0 + Focus.STALE_AFTER_MS + 1)).toBe("clear");
    expect(Focus.pollFailureDecision(0, null, T0)).toBe("clear");
  });
});

describe("focus remaining-minutes display", () => {
  it("rounds up so a session never shows zero while it still holds", () => {
    expect(Focus.remainingMinutes(3599)).toBe(60);
    expect(Focus.remainingMinutes(1801)).toBe(31);
    expect(Focus.remainingMinutes(1)).toBe(1);
  });

  it("shows nothing when there is no plan to count down", () => {
    expect(Focus.remainingMinutes(0)).toBeNull();
    expect(Focus.remainingMinutes(-5)).toBeNull();
    expect(Focus.remainingMinutes(null as unknown as number)).toBeNull();
  });
});
