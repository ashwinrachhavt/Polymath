import { describe, expect, it } from "vitest";
import { rankBetween } from "@/domains/work/rank";

describe("rankBetween", () => {
  it("starts from nothing and from the default rank", () => {
    expect(rankBetween(null, null)).toBe("n");
    expect(rankBetween("m", null) > "m").toBe(true);
    expect(rankBetween(null, "m") < "m").toBe(true);
  });

  it("always lands strictly between, including adjacent digits", () => {
    for (const [a, b] of [["m", "n"], ["a" + "b", "b"], ["z", "zb"], ["mz", "n"], ["b", "c"], ["bz", "c"]] as const) {
      const r = rankBetween(a, b);
      expect(r > a && r < b).toBe(true);
      expect(r.endsWith("a")).toBe(false);
    }
  });

  it("survives a thousand inserts at the same spot without a collision", () => {
    let lo = "m";
    const hi = "n";
    const seen = new Set<string>([lo, hi]);
    for (let i = 0; i < 1000; i++) {
      const r = rankBetween(lo, hi);
      expect(r > lo && r < hi).toBe(true);
      expect(seen.has(r)).toBe(false);
      seen.add(r);
      lo = r;
    }
  });

  it("random fuzz: result is strictly between and never ends in a", () => {
    const ranks = ["b", "m", "n", "z"];
    for (let i = 0; i < 2000; i++) {
      const sorted = [...ranks].sort();
      const k = Math.floor(Math.random() * (sorted.length - 1));
      const r = rankBetween(sorted[k], sorted[k + 1]);
      expect(r > sorted[k] && r < sorted[k + 1]).toBe(true);
      expect(r.endsWith("a")).toBe(false);
      ranks.push(r);
    }
  });

  it("accepts a stored a as a lower bound", () => {
    const r = rankBetween("a", "b");
    expect(r > "a" && r < "b").toBe(true);
    expect(rankBetween("a", null) > "a").toBe(true);
  });

  it("rejects inverted or malformed bounds", () => {
    expect(() => rankBetween("n", "m")).toThrow();
    expect(() => rankBetween("M1", null)).toThrow();
    expect(() => rankBetween("b", "ba")).toThrow(/no room/);
  });
});
