import type { CompanyResearchInput, SourceManifestEntry } from "./company-research";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";

/*
 * ASH-114 step 5: period-aligned financials and KPIs as structured rows, not
 * prose. The model proposes rows as JSON constrained to the source manifest;
 * validation is deterministic code - a row survives only with a canonical
 * metric, a period, a value and a citation that resolves into the manifest.
 * Rejected rows are counted and disclosed in the section, never smoothed
 * away. Basis (GAAP / non-GAAP / other) is labeled per row; the engine never
 * invents it.
 */

export const KPI_METRICS = [
  "revenue",
  "gross profit",
  "operating income",
  "net income",
  "EBITDA",
  "operating cash flow",
  "capex",
  "free cash flow",
  "cash",
  "debt",
  "leases",
  "contractual backlog",
] as const;

export type KpiRow = {
  metric: string;
  period: string;
  value: string;
  currency: string;
  basis: string;
  sourceRef: string;
};

const METRIC_LOOKUP = new Map(KPI_METRICS.map((m) => [m.toLowerCase(), m]));

/**
 * Parse the model's answer into raw row objects. Returns null when the answer
 * is not a JSON array at all (the caller then treats it as ordinary prose);
 * an empty array is a real result - the model found no supportable figures.
 */
export function parseKpiRows(raw: string): unknown[] | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keep only rows that cite real manifest evidence for a canonical metric. */
export function validateKpiRows(parsed: unknown[], manifestSize: number): { rows: KpiRow[]; dropped: number } {
  const rows: KpiRow[] = [];
  let dropped = 0;
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      dropped += 1;
      continue;
    }
    const r = item as Record<string, unknown>;
    const metric = typeof r.metric === "string" ? METRIC_LOOKUP.get(r.metric.trim().toLowerCase()) : undefined;
    const period = typeof r.period === "string" ? r.period.trim() : "";
    const value = typeof r.value === "number" ? String(r.value) : typeof r.value === "string" ? r.value.trim() : "";
    const sourceRaw = r.source ?? r.sourceRef ?? r.ref;
    const sourceNum = typeof sourceRaw === "number" ? sourceRaw : typeof sourceRaw === "string" ? Number(sourceRaw.replace(/^S/i, "").trim()) : NaN;
    if (!metric || !period || !value || !Number.isInteger(sourceNum) || sourceNum < 1 || sourceNum > manifestSize) {
      dropped += 1;
      continue;
    }
    rows.push({
      metric,
      period,
      value,
      currency: typeof r.currency === "string" && r.currency.trim() ? r.currency.trim() : "unspecified",
      basis: typeof r.basis === "string" && r.basis.trim() ? r.basis.trim() : "unspecified",
      sourceRef: `S${sourceNum}`,
    });
  }
  return { rows, dropped };
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** Render validated rows as the report's financial trend table. */
export function renderKpiTable(rows: KpiRow[], dropped: number): string {
  const lines = [
    "| Metric | Period | Value | Currency | Basis | Source |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${cell(r.metric)} | ${cell(r.period)} | ${cell(r.value)} | ${cell(r.currency)} | ${cell(r.basis)} | [${r.sourceRef}] |`),
  ];
  if (dropped > 0) lines.push(`\n_${dropped} reported figure${dropped === 1 ? "" : "s"} could not be grounded in the source manifest and ${dropped === 1 ? "was" : "were"} excluded._`);
  return lines.join("\n");
}

export const KPI_SYSTEM_RULES = `Answer with ONLY a JSON array of financial figures found in the manifest sources. Each element has exactly these keys: {"metric","period","value","currency","basis","source"}.
"metric": one of ${KPI_METRICS.join(", ")}.
"period": the reporting period the figure is stated for (for example FY2025 or Q2 2025).
"value": the reported figure with its unit, exactly as the source states it.
"currency": the currency of the figure.
"basis": the accounting basis (GAAP, non-GAAP, or another label the source uses).
"source": the manifest ref "S#" the figure came from.
Report only figures that appear verbatim in the sources; invent nothing; separate metrics stay separate rows, never merged or derived. If the sources contain no usable figures, answer with [] and nothing else - never estimate a missing figure to fill the shape. ${untrustedDataClauseJsonSafe("sources")}`;

/** Prompt for the financial section: structured extraction instead of prose. */
export function buildKpiPrompt(input: CompanyResearchInput, manifest: SourceManifestEntry[]): string {
  const lines = manifest.map((m) => `[${m.ref}] ${m.title} - ${m.url}${m.publishedAt ? ` (published ${m.publishedAt})` : " (undated)"}`);
  return [
    `Extract period-aligned financials and KPIs for ${input.companyName.trim()} from this source manifest.`,
    input.asOfDate ? `Use only evidence available by ${input.asOfDate}.` : "",
    KPI_SYSTEM_RULES,
    "",
    ...lines,
  ].filter(Boolean).join("\n");
}
