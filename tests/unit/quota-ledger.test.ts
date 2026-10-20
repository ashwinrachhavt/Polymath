import { describe, expect, it } from "vitest";
import { currentPeriod, QuotaExhaustedError, withQuota, type QuotaStore } from "@/integrations/providers/quota";
import { providerEntry } from "@/integrations/providers/registry";

/*
 * The reservation flow, proven against a fake store: reserve before execute,
 * settle the actual units, release on failure, and stop hard at the cap. The
 * Postgres store's atomicity invariant (no over-draw under concurrency) is
 * the integration suite's job — a fake cannot show it.
 */

type Bucket = { reserved: number; consumed: number };
function fakeStore(allowance: number) {
  const bucket: Bucket = { reserved: 0, consumed: 0 };
  const events: string[] = [];
  const store: QuotaStore = {
    async reserve(_key, units) {
      // The fake enforces its own cap; the real store gets it from the registry entry.
      if (units > allowance || bucket.consumed + bucket.reserved + units > allowance) return null;
      bucket.reserved += units;
      events.push(`reserve:${units}`);
      return { bucketId: "b1" };
    },
    async settle(_id, held, actual) {
      bucket.reserved -= held;
      bucket.consumed += actual;
      events.push(`settle:${actual}`);
    },
    async release(_id, held) {
      bucket.reserved -= held;
      events.push(`release:${held}`);
    },
  };
  return { store, bucket, events };
}

const firecrawl = providerEntry("firecrawl")!;

describe("withQuota", () => {
  it("reserves, executes and settles in order", async () => {
    const { store, bucket, events } = fakeStore(1000);
    const out = await withQuota(store, firecrawl, "w1", 2, async () => "done");
    expect(out).toBe("done");
    expect(events).toEqual(["reserve:2", "settle:2"]);
    expect(bucket).toEqual({ reserved: 0, consumed: 2 });
  });

  it("stops hard when the allowance is exhausted, before the call runs", async () => {
    const { store, bucket } = fakeStore(2);
    let calls = 0;
    await withQuota(store, firecrawl, "w1", 2, async () => {
      calls++;
      return "ok";
    });
    await expect(
      withQuota(store, firecrawl, "w1", 2, async () => {
        calls++;
        return "never";
      }),
    ).rejects.toThrow(QuotaExhaustedError);
    expect(calls).toBe(1); // the second call never reached the provider
    expect(bucket.consumed).toBe(2);
  });

  it("releases the reservation when the provider call fails", async () => {
    const { store, bucket, events } = fakeStore(1000);
    await expect(
      withQuota(store, firecrawl, "w1", 2, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    expect(events).toEqual(["reserve:2", "release:2"]);
    expect(bucket).toEqual({ reserved: 0, consumed: 0 }); // failure does not burn the allowance
  });

  it("settles the actual units when they differ from the estimate", async () => {
    const { store, bucket } = fakeStore(1000);
    await withQuota(store, firecrawl, "w1", 10, async () => 3, (n) => n);
    expect(bucket).toEqual({ reserved: 0, consumed: 3 });
  });
});

describe("currentPeriod", () => {
  // Unit tests run under the pinned clock: 2026-01-15T12:00:00Z, which is 04:00 Pacific.
  it("uses the UTC calendar month for monthly allowances", () => {
    expect(currentPeriod("monthly")).toBe("2026-01");
  });
  it("uses the Pacific date for daily allowances (Gemini resets at midnight Pacific)", () => {
    expect(currentPeriod("daily")).toBe("2026-01-15");
    // 06:30 UTC on Jan 15 is still Jan 14 at 22:30 Pacific.
    expect(currentPeriod("daily", new Date("2026-01-15T06:30:00Z"))).toBe("2026-01-14");
  });
});
