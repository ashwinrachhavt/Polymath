import { describe, expect, it } from "vitest";
import { dedupeByPrompt, defaultItemCount, planBatches } from "@/domains/learning/item-count";

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
