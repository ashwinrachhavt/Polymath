import { describe, expect, it } from "vitest";
import { dedupeByPrompt, defaultItemCount, generateInBatches, planBatches } from "@/domains/learning/item-count";

describe("defaultItemCount", () => {
  it("scales a substantial source to 20-50 items", () => {
    expect(defaultItemCount(30000)).toBe(50);
    expect(defaultItemCount(15000)).toBe(25);
    expect(defaultItemCount(12000)).toBe(20);
  });

  it("never pads a short source up to 20", () => {
    expect(defaultItemCount(3000)).toBe(5);
    expect(defaultItemCount(1200)).toBe(5);
  });
});

describe("planBatches", () => {
  it("splits a request into batches of at most 25", () => {
    expect(planBatches(50)).toEqual([25, 25]);
    expect(planBatches(30)).toEqual([25, 5]);
    expect(planBatches(7)).toEqual([7]);
  });
});

describe("dedupeByPrompt", () => {
  it("drops a prompt that differs only by case and whitespace, keeping the first", () => {
    const items = [{ prompt: "What is X? " }, { prompt: "what is x?" }, { prompt: "What is Y?" }];
    expect(dedupeByPrompt(items)).toEqual([{ prompt: "What is X? " }, { prompt: "What is Y?" }]);
  });
});

describe("generateInBatches", () => {
  /** Proposes `perCall(count)` new, distinct items per call, numbered across calls. */
  function proposer(perCall: (count: number, batch: number) => number) {
    const batches: number[] = [];
    let next = 0;
    const propose = async (count: number, _avoid: string[], batch: number) => {
      batches.push(batch);
      return Array.from({ length: perCall(count, batch) }, () => ({ prompt: `Item ${next++}?` }));
    };
    return { propose, batches };
  }

  it("reports complete when every requested item is made, numbering each batch", async () => {
    const { propose, batches } = proposer((count) => count);
    const out = await generateInBatches(30, propose);
    expect(out.items).toHaveLength(30);
    expect(out.stoppedBy).toBe("complete");
    expect(batches).toEqual([0, 1]);
  });

  it("keeps going after a batch that is only a little short", async () => {
    const { propose, batches } = proposer(() => 20);
    const out = await generateInBatches(50, propose);
    expect(batches).toEqual([0, 1]);
    expect(out.items).toHaveLength(40);
    expect(out.stoppedBy).toBe("source_exhausted");
  });

  it("stops as source_exhausted when a batch makes less than half its count", async () => {
    const { propose, batches } = proposer(() => 8);
    const out = await generateInBatches(50, propose);
    expect(batches).toEqual([0]);
    expect(out).toMatchObject({ stoppedBy: "source_exhausted" });
    expect(out.items).toHaveLength(8);
  });

  it("reports batch_failed, not source_exhausted, when a later call fails", async () => {
    const { propose } = proposer((count, batch) => {
      if (batch === 1) throw new Error("quota denied");
      return count;
    });
    const out = await generateInBatches(50, propose);
    expect(out.items).toHaveLength(25);
    expect(out.stoppedBy).toBe("batch_failed");
  });

  it("counts a batch as made only once keep succeeds", async () => {
    const { propose } = proposer((count) => count);
    let keeps = 0;
    const out = await generateInBatches(50, propose, async () => {
      keeps += 1;
      if (keeps === 2) throw new Error("insert failed");
    });
    expect(out.items).toHaveLength(25);
    expect(out.stoppedBy).toBe("batch_failed");
  });

  it("throws when the first call fails", async () => {
    const { propose } = proposer(() => {
      throw new Error("provider down");
    });
    await expect(generateInBatches(30, propose)).rejects.toThrow("provider down");
  });
});
