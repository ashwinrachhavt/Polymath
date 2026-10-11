import { describe, expect, it } from "vitest";
import { keywordCoverage } from "@/components/products/command-center/application-coverage";

describe("application keyword coverage", () => {
  it("compares literal case-insensitive keywords without inventing a score", () => {
    expect(keywordCoverage("TypeScript and systems design", "typescript, Python\nSYSTEMS DESIGN,typescript")).toEqual({ error: "", matched: ["typescript", "systems design"], missing: ["python"] });
  });
  it("rejects unbounded keyword requests", () => {
    expect(keywordCoverage("", Array.from({ length: 51 }, (_, index) => `term${index}`).join(",")).error).toContain("at most 50");
    expect(keywordCoverage("", "x".repeat(81)).error).toContain("80 characters");
  });
  it("does not report empty input as perfect coverage", () => {
    expect(keywordCoverage("", " ,\n ")).toEqual({ error: "", matched: [], missing: [] });
  });
});
