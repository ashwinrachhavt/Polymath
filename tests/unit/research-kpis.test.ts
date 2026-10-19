import { describe, expect, it } from "vitest";
import { buildKpiPrompt, parseKpiRows, renderKpiTable, validateKpiRows } from "@/domains/knowledge/research-kpis";

/*
 * ASH-114 step 5: KPI extraction is deterministic on the engine side. The
 * model proposes rows; these tests pin what survives validation - canonical
 * metrics only, a period and a value always, and a citation that resolves
 * into the manifest. Everything else is dropped and disclosed, not smoothed.
 */

describe("parseKpiRows", () => {
  it("parses a JSON array, fenced or bare", () => {
    expect(parseKpiRows('[{"metric":"revenue"}]')).toEqual([{ metric: "revenue" }]);
    expect(parseKpiRows('```json\n[{"metric":"revenue"}]\n```')).toEqual([{ metric: "revenue" }]);
  });

  it("returns null for prose so the caller keeps the ordinary section path", () => {
    expect(parseKpiRows("The evidence supports this section [S1].")).toBeNull();
    expect(parseKpiRows("not json at all")).toBeNull();
  });

  it("treats an empty array as a real result, not a parse failure", () => {
    expect(parseKpiRows("[]")).toEqual([]);
  });
});

describe("validateKpiRows", () => {
  it("keeps rows with a canonical metric, period, value and a resolving citation", () => {
    const { rows, dropped } = validateKpiRows(
      [
        { metric: "Revenue", period: "FY2025", value: "12.4B", currency: "USD", basis: "GAAP", source: "S2" },
        { metric: "ebitda", period: "Q4 2025", value: 3.1, source: 1 },
      ],
      3,
    );
    expect(dropped).toBe(0);
    expect(rows).toEqual([
      { metric: "revenue", period: "FY2025", value: "12.4B", currency: "USD", basis: "GAAP", sourceRef: "S2" },
      { metric: "EBITDA", period: "Q4 2025", value: "3.1", currency: "unspecified", basis: "unspecified", sourceRef: "S1" },
    ]);
  });

  it("drops rows that are ungrounded, uncanonical or incomplete, and counts them", () => {
    const { rows, dropped } = validateKpiRows(
      [
        { metric: "revenue", period: "FY2025", value: "12.4B", source: "S9" }, // citation outside the manifest
        { metric: "revenue", period: "FY2025", value: "12.4B" }, // no citation at all
        { metric: "vibes", period: "FY2025", value: "high", source: "S1" }, // non-canonical metric
        { metric: "revenue", value: "12.4B", source: "S1" }, // no period
        { metric: "revenue", period: "FY2025", source: "S1" }, // no value
        "not an object",
      ],
      3,
    );
    expect(rows).toEqual([]);
    expect(dropped).toBe(6);
  });
});

describe("renderKpiTable", () => {
  it("renders period, currency, basis and the citation per row", () => {
    const table = renderKpiTable(
      [{ metric: "revenue", period: "FY2025", value: "12.4B", currency: "USD", basis: "GAAP", sourceRef: "S2" }],
      0,
    );
    expect(table).toContain("| Metric | Period | Value | Currency | Basis | Source |");
    expect(table).toContain("| revenue | FY2025 | 12.4B | USD | GAAP | [S2] |");
  });

  it("discloses dropped figures instead of hiding them", () => {
    const table = renderKpiTable([{ metric: "cash", period: "FY2025", value: "$2B", currency: "USD", basis: "unspecified", sourceRef: "S1" }], 2);
    expect(table).toContain("2 reported figures could not be grounded");
    expect(table).toContain("$2B"); // pipes in values are escaped, not broken
  });
});

describe("buildKpiPrompt", () => {
  it("constrains extraction to the manifest and the canonical metric list", () => {
    const prompt = buildKpiPrompt(
      { companyName: "Acme", asOfDate: "2026-01-01" },
      [{ ref: "S1", title: "10-K", url: "https://x", publishedAt: null, retrievedAt: "t", query: null }],
    );
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("contractual backlog");
    expect(prompt).toContain("[S1] 10-K");
    expect(prompt).toContain("2026-01-01");
  });
});
