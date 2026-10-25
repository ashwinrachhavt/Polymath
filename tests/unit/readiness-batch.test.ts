import { describe, expect, it } from "vitest";
import { parseReadinessIds, phaseForReadiness } from "@/domains/knowledge/readiness-batch";

/*
 * GET /api/v1/documents/readiness validates its `ids` query before touching
 * the database, and the vault/notebook pollers map a readiness row to copy.
 * Both halves are pure, so they are proven here; the workspace scoping and
 * state derivation itself are listSources's job and are covered by the
 * DB-backed suites (document-library.test.ts) in CI.
 */

function uuid(n: number): string {
  const hex = n.toString(16).padStart(4, "0");
  return `00000000-0000-4000-8000-${hex.padStart(12, "0")}`;
}

describe("parseReadinessIds", () => {
  it("rejects a missing or blank list", () => {
    expect(parseReadinessIds(null).ok).toBe(false);
    expect(parseReadinessIds("").ok).toBe(false);
    expect(parseReadinessIds("  ,  ,").ok).toBe(false);
  });

  it("trims, drops empties, and deduplicates", () => {
    const parsed = parseReadinessIds(` ${uuid(1)} , ${uuid(1)} ,,${uuid(2)} `);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ids).toEqual([uuid(1), uuid(2)]);
  });

  it("accepts up to 50 ids and rejects more", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => uuid(i + 1)).join(",");
    expect(parseReadinessIds(fifty).ok).toBe(true);
    const fiftyOne = `${fifty},${uuid(51)}`;
    const parsed = parseReadinessIds(fiftyOne);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/50/);
  });

  it("rejects a non-UUID id", () => {
    const parsed = parseReadinessIds(`${uuid(1)},not-a-uuid`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/UUID/);
  });
});

describe("phaseForReadiness", () => {
  it("maps in-flight states to progress copy", () => {
    expect(phaseForReadiness("queued", null)).toEqual({ phase: "Queued", terminal: null });
    expect(phaseForReadiness("extracting", "Reading the source.")).toEqual({
      phase: "Reading…",
      terminal: null,
    });
    expect(phaseForReadiness("embedding", null)).toEqual({ phase: "Indexing for search…", terminal: null });
  });

  it("maps ready to the done terminal", () => {
    expect(phaseForReadiness("ready", null)).toEqual({ phase: "Ready", terminal: "done" });
  });

  it("surfaces the failure reason, or an honest fallback", () => {
    expect(phaseForReadiness("failed", "The PDF is password-protected.")).toEqual({
      phase: "The PDF is password-protected.",
      terminal: "error",
    });
    expect(phaseForReadiness("unsupported", null).terminal).toBe("error");
    expect(phaseForReadiness("unsupported", null).phase.length).toBeGreaterThan(0);
  });
});
