import { describe, expect, it } from "vitest";
import { applyFlowFilter, parseFlowFilter, topicsOf } from "@/domains/work/flow-filters";

const tasks = [
  { id: "1", priority: "urgent", tags: ["Deep"] },
  { id: "2", priority: "high", tags: ["admin", "deep"] },
  { id: "3", priority: "medium", tags: [] },
  { id: "4", priority: "low", tags: ["admin"] },
  { id: "5", priority: "none", tags: "bad" },
];

describe("flow filters", () => {
  it("parses topic and priority, ignoring junk", () => {
    expect(parseFlowFilter({ ft: " Deep ", fp: "P2" })).toEqual({ topic: "deep", priority: "p2" });
    expect(parseFlowFilter({ fp: "p9" })).toEqual({ topic: null, priority: null });
    expect(parseFlowFilter({ ft: ["a", "b"] }).topic).toBe("a");
  });

  it("filters by priority chip", () => {
    expect(applyFlowFilter(tasks, { topic: null, priority: "p1" }).map((t) => t.id)).toEqual(["1"]);
    expect(applyFlowFilter(tasks, { topic: null, priority: "p3" }).map((t) => t.id)).toEqual(["3"]);
  });

  it("filters by topic case-insensitively and combines with priority", () => {
    expect(applyFlowFilter(tasks, { topic: "deep", priority: null }).map((t) => t.id)).toEqual(["1", "2"]);
    expect(applyFlowFilter(tasks, { topic: "deep", priority: "p2" }).map((t) => t.id)).toEqual(["2"]);
  });

  it("shows everything with no filter, malformed tags included", () => {
    expect(applyFlowFilter(tasks, { topic: null, priority: null })).toHaveLength(5);
  });

  it("lists topics by use, capped", () => {
    expect(topicsOf(tasks)).toEqual(["admin", "deep"]);
    expect(topicsOf(tasks, 1)).toEqual(["admin"]);
  });
});
