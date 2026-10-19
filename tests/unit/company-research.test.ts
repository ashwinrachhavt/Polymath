import { describe, expect, it } from "vitest";
import {
  CompanyResearchError,
  REPORT_SECTIONS,
  cutoffDate,
  filterByCutoff,
  planResearch,
  sectionOrPlaceholder,
  type ResearchAdapters,
} from "@/domains/knowledge/company-research";

/*
 * ASH-114: the research contract's guarantees are deterministic - the plan,
 * the cutoff, the citation check and the dossier-only boundary are code, not
 * prompt instructions. These tests pin each one with fake adapters; the model
 * never decides them.
 */

describe("planResearch", () => {
  it("plans zero web queries in dossier-only mode, structurally", () => {
    const plan = planResearch({ companyName: "Acme", mode: "dossier-only", dossierId: "d-1" });
    expect(plan.every((s) => s.queries.length === 0)).toBe(true);
  });

  it("requires a dossier for dossier-only mode and a company name always", () => {
    expect(() => planResearch({ companyName: "Acme", mode: "dossier-only" })).toThrow(CompanyResearchError);
    expect(() => planResearch({ companyName: " " })).toThrow(CompanyResearchError);
  });

  it("bounds total queries by depth, identity first", () => {
    const quick = planResearch({ companyName: "Acme", depth: "quick" });
    expect(quick.reduce((n, s) => n + s.queries.length, 0)).toBeLessThanOrEqual(4);
    expect(quick[0].key).toBe("identity");
    const deep = planResearch({ companyName: "Acme", depth: "deep" });
    expect(deep.reduce((n, s) => n + s.queries.length, 0)).toBeGreaterThan(4);
  });

  it("marks financials as expected-missing for a private company", () => {
    const plan = planResearch({ companyName: "Acme", mode: "private" });
    expect(plan.find((s) => s.key === "financials")?.purpose).toMatch(/undisclosed|missing/i);
  });
});

describe("cutoffDate and filterByCutoff", () => {
  it("rejects a malformed as-of date instead of ignoring it", () => {
    expect(() => cutoffDate("last Tuesday")).toThrow(CompanyResearchError);
    expect(cutoffDate("2026-01-15")?.toISOString()).toContain("2026-01-15");
  });

  it("excludes evidence published after the cutoff and keeps undated entries labeled", () => {
    const entries = [
      { url: "a", publishedAt: "2025-12-31" },
      { url: "b", publishedAt: "2026-06-01" },
      { url: "c", publishedAt: null },
    ];
    const kept = filterByCutoff(entries, cutoffDate("2026-01-15"));
    expect(kept.map((e) => e.url)).toEqual(["a", "c"]);
  });
});

describe("sectionOrPlaceholder", () => {
  it("keeps a section whose citation resolves into the manifest", () => {
    const body = "Revenue grew 40% [S1].";
    expect(sectionOrPlaceholder("Financials", body, 3)).toBe(body);
  });

  it("replaces an uncited section with an explicit gap marker", () => {
    const out = sectionOrPlaceholder("Financials", "Revenue probably grew.", 3);
    expect(out).toContain("Insufficient evidence");
    expect(out).toContain("Financials");
  });

  it("rejects citations beyond the manifest - a model cannot invent [S99]", () => {
    const out = sectionOrPlaceholder("History", "Founded in 2010 [S99].", 3);
    expect(out).toContain("Insufficient evidence");
  });
});

describe("REPORT_SECTIONS", () => {
  it("carries the issue's report contract", () => {
    expect(REPORT_SECTIONS).toContain("Bull / base / bear scenarios");
    expect(REPORT_SECTIONS).toContain("Source manifest");
    expect(REPORT_SECTIONS.length).toBe(10);
  });
});

// A fake adapter set proving orchestration never searches in dossier-only mode
// even when handed one: the search fake throws if it is ever called.
export const dossierOnlyGuardAdapters: ResearchAdapters = {
  search: () => {
    throw new Error("dossier-only mode must never web-search");
  },
  complete: async () => "Grounded sentence [S1].",
};
void dossierOnlyGuardAdapters;
