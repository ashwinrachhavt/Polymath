import { describe, expect, it } from "vitest";
import { FolderError, normalizeFolderName, normalizeTag } from "@/domains/knowledge/folders";

describe("folder and tag normalisation", () => {
  it("collapses whitespace in folder names and bounds the length", () => {
    expect(normalizeFolderName("  Tax   2026 ")).toBe("Tax 2026");
    expect(() => normalizeFolderName("   ")).toThrow(FolderError);
    expect(() => normalizeFolderName("x".repeat(81))).toThrow(FolderError);
    expect(normalizeFolderName("x".repeat(80))).toHaveLength(80);
  });

  it("lowercases tags, strips a leading hash, and bounds the length", () => {
    expect(normalizeTag(" #Tax  Return ")).toBe("tax return");
    expect(() => normalizeTag("#")).toThrow(FolderError);
    expect(() => normalizeTag("y".repeat(41))).toThrow(FolderError);
  });
});
