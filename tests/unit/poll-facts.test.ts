import { describe, expect, it } from "vitest";
import { buildRotation, pollFacts, selectFactPool } from "@/lib/poll-facts";

describe("selectFactPool", () => {
  it("prefers the tag-matched pool when it is deep enough", () => {
    const pool = selectFactPool(["light", "time"]);
    expect(pool.length).toBeGreaterThanOrEqual(3);
    expect(pool.length).toBeLessThan(pollFacts.length);
    for (const fact of pool) {
      expect(fact.tags.some((tag) => ["light", "time"].includes(tag))).toBe(true);
    }
  });

  it("falls back to the whole deck when the match is shallow", () => {
    expect(selectFactPool(["nonexistent-topic"])).toEqual(pollFacts);
    expect(selectFactPool([])).toEqual(pollFacts);
  });
});

describe("buildRotation", () => {
  it("walks every fact exactly once before repeating", () => {
    const pool = selectFactPool([]);
    const seen: string[] = [];
    let remaining = pool;
    for (let i = 0; i < pool.length; i++) {
      const rotation = buildRotation(remaining);
      seen.push(rotation[0].id);
      remaining = remaining.filter((fact) => fact.id !== rotation[0].id);
    }
    expect(new Set(seen).size).toBe(pool.length);
  });

  it("returns a permutation of the pool, not a new set", () => {
    const pool = selectFactPool(["diagram", "rendering", "motion", "light"]).slice(0, 5);
    const ids = (rotation: ReturnType<typeof buildRotation>) => rotation.map((fact) => fact.id).sort();
    expect(ids(buildRotation(pool))).toEqual(ids(pool));
  });
});
