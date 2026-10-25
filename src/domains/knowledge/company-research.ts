import { and, eq } from "drizzle-orm";
import { untrustedDataClause } from "@/lib/prompts";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { buildKpiPrompt, parseKpiRows, renderKpiTable, validateKpiRows } from "./research-kpis";
import { searchWebForAgent } from "./web-search";
import { artifactVersions, artifacts, documents, dossierSources, sources } from "./schema";

/*
 * Company research (ASH-114): an evidence-grounded business case study. The
 * contract that matters is not "produce prose about a company"; it is:
 *
 *  - dossier-only mode never silently web-searches (a broader source scope is
 *    an explicit caller choice, not a fallback);
 *  - historical mode excludes evidence published after the as-of date;
 *  - private companies report missing data instead of fabricating financials;
 *  - every section carries source citations [S#] into a dated manifest, and a
 *    section the evidence cannot support degrades to an explicit
 *    "insufficient evidence" marker - the conflict is preserved, not smoothed;
 *  - scenarios are labeled hypotheses, never predictions or investment advice.
 *
 * Generation goes through injected adapters so tests drive a fake model and
 * fake search; the default adapters are the workspace's web-search capability
 * and the same OpenRouter path the wiki summarizer uses.
 */

export const REPORT_SECTIONS = [
  "Executive answer and central question",
  "Company history and strategic turning points",
  "Customer problem, value proposition and business model",
  "Revenue and segment map, competitive landscape",
  "Financial trend table",
  "Current strategic bet and causal chain",
  "Cash, capital and financing",
  "Bull / base / bear scenarios",
  "Balanced synthesis and unresolved questions",
  "Source manifest",
] as const;

export type ResearchMode = "public" | "private" | "dossier-only";
export type ResearchDepth = "quick" | "standard" | "deep";

export type CompanyResearchInput = {
  companyName: string;
  question?: string;
  audience?: string;
  depth?: ResearchDepth;
  /** ISO date (YYYY-MM-DD). Evidence published after this date is excluded. */
  asOfDate?: string;
  mode?: ResearchMode;
  /** Required for dossier-only mode. */
  dossierId?: string;
  /** Optional peer companies the competitive analysis is compared against. */
  peers?: string[];
  idempotencyKey?: string;
};

export type SourceManifestEntry = {
  ref: string;
  title: string;
  url: string;
  publishedAt: string | null;
  retrievedAt: string;
  query: string | null;
};

export type ResearchPlanStep = { key: string; purpose: string; queries: string[] };

export interface ResearchSearchResult {
  title: string;
  url: string;
  publishedAt?: string | null;
  snippet?: string;
}

export interface ResearchAdapters {
  search(query: string, limit: number): Promise<ResearchSearchResult[]>;
  complete(section: string, prompt: string): Promise<string>;
}

export class CompanyResearchError extends Error {
  readonly code = "company_research_input";
  constructor(message: string) {
    super(message);
    this.name = "CompanyResearchError";
  }
}

const QUERIES_BY_DEPTH: Record<ResearchDepth, number> = { quick: 4, standard: 8, deep: 12 };
const SEARCH_LIMIT = 5;
const CITATION = /\[S(\d+)\]/g;

const money = (s: string) => s.replace(/"/g, "'");

/**
 * The evidence plan. Pure: no adapters, no db, no model. Dossier-only mode
 * plans zero web queries - that is the "never silently web-search" guarantee,
 * and it is structural (no query text exists to run), not a runtime flag.
 */
/** Trim, dedupe and cap the peer list; blank entries are a caller error, not a silent drop. */
export function normalizePeers(peers?: string[]): string[] {
  if (!peers?.length) return [];
  if (peers.some((p) => !p.trim())) throw new CompanyResearchError("Peer names cannot be blank.");
  const out = [...new Set(peers.map((p) => p.trim()))];
  if (out.length > 5) throw new CompanyResearchError("Compare at most 5 peers in one research pass.");
  if (out.some((p) => p.length > 200)) throw new CompanyResearchError("Peer names are limited to 200 characters.");
  return out;
}

export function planResearch(input: CompanyResearchInput): ResearchPlanStep[] {
  const mode = input.mode ?? "public";
  const depth = input.depth ?? "standard";
  const name = input.companyName.trim();
  if (!name) throw new CompanyResearchError("Name the company to research.");
  const peers = normalizePeers(input.peers);
  if (mode === "dossier-only") {
    if (!input.dossierId) throw new CompanyResearchError("Dossier-only research needs a dossierId.");
    return [
      { key: "dossier", purpose: "Read only the pinned dossier sources; nothing is fetched from the web.", queries: [] },
    ];
  }
  const cutoff = input.asOfDate ? ` (before ${input.asOfDate})` : "";
  const pool: ResearchPlanStep[] = [
    { key: "identity", purpose: "Legal identity, ticker or domain, parent boundary", queries: [`"${money(name)}" investor relations OR annual report${cutoff}`] },
    { key: "model", purpose: "Customer problem, products, revenue model", queries: [`"${money(name)}" business model revenue segments${cutoff}`, `"${money(name)}" 10-K business section${cutoff}`] },
    { key: "timeline", purpose: "Turning points and strategic choices", queries: [`"${money(name)}" history strategy shift${cutoff}`, `"${money(name)}" earnings call strategy${cutoff}`] },
    { key: "financials", purpose: "Period-aligned financials and KPIs", queries: [`"${money(name)}" revenue operating income free cash flow annual${cutoff}`, `"${money(name)}" quarterly results debt cash${cutoff}`] },
    { key: "competition", purpose: "Competitive position and risks", queries: [`"${money(name)}" competitors market share${cutoff}`, `"${money(name)}" risk factors customer concentration${cutoff}`] },
    { key: "scenarios", purpose: "Bull/base/bear inputs and counterarguments", queries: [`"${money(name)}" analyst bull bear case${cutoff}`, `"${money(name)}" criticism downside risk${cutoff}`] },
  ];
  if (peers.length) {
    const competition = pool[4];
    competition.queries = [
      `"${money(name)}" vs ${peers.map((p) => `"${money(p)}"`).join(" ")}${cutoff}`,
      ...competition.queries,
    ];
  }
  if (mode === "private") {
    // Private companies: search what exists (news, funding, site) but plan
    // marks financials as expected-missing rather than implying coverage.
    return [
      pool[0],
      pool[1],
      pool[2],
      { key: "financials", purpose: "Financials are usually undisclosed for a private company; record what is public and mark the rest missing.", queries: pool[3].queries.slice(0, 1) },
      pool[4],
    ].map((step) => ({ ...step, queries: step.queries }));
  }
  // Bound total query count by depth, keeping step order (identity first).
  const budget = QUERIES_BY_DEPTH[depth];
  const out: ResearchPlanStep[] = [];
  let spent = 0;
  for (const step of pool) {
    const room = Math.max(budget - spent, 0);
    const queries = step.queries.slice(0, room);
    if (!queries.length) break;
    spent += queries.length;
    out.push({ ...step, queries });
  }
  return out;
}

/** Parse an ISO date boundary; invalid input is a caller error, not a silent ignore. */
export function cutoffDate(asOfDate?: string): Date | null {
  if (!asOfDate) return null;
  const d = new Date(`${asOfDate}T23:59:59Z`);
  if (Number.isNaN(d.getTime())) throw new CompanyResearchError(`asOfDate "${asOfDate}" is not a YYYY-MM-DD date.`);
  return d;
}

/**
 * Keep only manifest evidence available by the cutoff. Entries with no
 * publication date are kept and labeled undated - dropping them would hide
 * what the conclusion rests on; the report marks them.
 */
export function filterByCutoff<T extends { publishedAt: string | null }>(entries: T[], cutoff: Date | null): T[] {
  if (!cutoff) return entries;
  return entries.filter((e) => {
    if (!e.publishedAt) return true;
    const d = new Date(e.publishedAt);
    return Number.isNaN(d.getTime()) || d <= cutoff;
  });
}

/**
 * A section survives only with at least one citation that resolves into the
 * manifest. Anything else becomes an explicit insufficient-evidence marker:
 * the reader sees the gap instead of a confident unsourced paragraph.
 */
export function sectionOrPlaceholder(section: string, body: string, manifestSize: number): string {
  const cited = new Set<number>();
  for (const m of body.matchAll(CITATION)) cited.add(Number(m[1]));
  const valid = [...cited].filter((n) => n >= 1 && n <= manifestSize);
  if (valid.length > 0) return body.trim();
  return `> [!NOTE] Insufficient evidence\n> The research pass could not ground "${section}" in the source manifest. This is a recorded gap, not a summary.`;
}

async function loadDossierManifest(tx: TxDrizzle, auth: AuthContext, dossierId: string): Promise<SourceManifestEntry[]> {
  // Dossiers pin sources rows; a source is a URL or a workspace document
  // (sources.fileId). Document entries cite their document id as the locator -
  // no URL is fabricated for a record that has none.
  const rows = await tx
    .select({ sourceId: sources.id, title: sources.title, url: sources.url, fileId: sources.fileId, documentTitle: documents.title, documentId: documents.id, note: dossierSources.note })
    .from(dossierSources)
    .innerJoin(sources, eq(sources.id, dossierSources.sourceId))
    .leftJoin(documents, and(eq(documents.fileId, sources.fileId), eq(documents.workspaceId, auth.workspaceId)))
    .where(and(eq(dossierSources.workspaceId, auth.workspaceId), eq(dossierSources.dossierId, dossierId)));
  const now = new Date().toISOString();
  return rows.map((r, i) => ({
    ref: `S${i + 1}`,
    title: r.title ?? r.documentTitle ?? r.url ?? "pinned source",
    url: r.url ?? `document:${r.documentId ?? r.sourceId}`,
    publishedAt: null,
    retrievedAt: now,
    query: null,
  }));
}

function defaultAdapters(auth: AuthContext): ResearchAdapters {
  return {
    async search(query, limit) {
      const res = await searchWebForAgent(auth, { query, limit });
      if (!res.ok) return [];
      return res.results.map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        publishedAt: "publishedAt" in r ? (r.publishedAt ?? null) : null,
        snippet: "snippet" in r ? (r.snippet as string | undefined) : undefined,
      }));
    },
    async complete(section, prompt) {
      return openRouterSection(section, prompt);
    },
  };
}

const COMPLETE_URL = "https://openrouter.ai/api/v1/chat/completions";
const COMPLETE_MODEL = () => process.env.RESEARCH_MODEL || "openai/gpt-4o-mini";
const MAX_PROMPT_CHARS = 24_000;

export const SECTION_SYSTEM = `You write one section of an evidence-grounded business case study.

Rules:
- Cite every factual claim inline as [S#], matching the source manifest in the brief. Place the citation immediately after the statement it supports. A statement without a citation must be explicitly marked as your analysis ("My read: ...").
- Use only the sources in the manifest, never general knowledge.
- Never invent facts, numbers, or links. A figure is either in a source or absent; distinguish reported figures from estimates.
- Scenarios are hypotheses, never predictions or personalized investment advice.

Before writing, check the manifest for passages supporting the section. If the sources cannot support it, answer with exactly this sentence and nothing else: "The sources cannot support this section."

${untrustedDataClause("brief")}`;

/** Default section writer: one OpenRouter chat completion, mirroring the wiki summarizer's plumbing. */
async function openRouterSection(section: string, prompt: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "";
  const res = await fetchImpl(COMPLETE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: COMPLETE_MODEL(),
      temperature: 0,
      messages: [
        { role: "system", content: SECTION_SYSTEM },
        { role: "user", content: `Section: ${section}\n\n${prompt.slice(0, MAX_PROMPT_CHARS)}` },
      ],
    }),
  });
  if (!res.ok) return "";
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

function buildSectionPrompt(input: CompanyResearchInput, section: string, manifest: SourceManifestEntry[]): string {
  const lines = manifest.map((m) => `[${m.ref}] ${m.title} - ${m.url}${m.publishedAt ? ` (published ${m.publishedAt})` : " (undated)"}`);
  return [
    `Write the "${section}" section of an evidence-grounded business case study on ${input.companyName.trim()}.`,
    input.question ? `Central question: ${input.question}` : "",
    input.audience ? `Audience: ${input.audience}.` : "",
    normalizePeers(input.peers).length ? `Peer companies for the competitive comparison: ${normalizePeers(input.peers).join(", ")}.` : "",
    `Cite sources inline as [S#] exactly matching this manifest. Use only these sources; invent nothing. If the sources cannot support the section, say so in one sentence instead of writing around the gap. Scenarios are hypotheses, never predictions or investment advice.`,
    "",
    ...lines,
  ].filter(Boolean).join("\n");
}

export type CompanyResearchResult = {
  artifactId: string;
  versionId: string;
  title: string;
  manifestSize: number;
  groundedSections: number;
  gapSections: number;
  replayed: boolean;
};

/**
 * Run the research pass and persist the report as a versioned Studio artifact
 * (kind "report") with one sources row per manifest entry, in one idempotent
 * transaction. The model writes prose; the manifest, cutoff, citation check
 * and placeholders are deterministic and never delegated to it.
 */
export async function runCompanyResearch(
  auth: AuthContext,
  input: CompanyResearchInput,
  adapters?: ResearchAdapters,
): Promise<CompanyResearchResult> {
  const mode = input.mode ?? "public";
  const plan = planResearch(input);
  const cutoff = cutoffDate(input.asOfDate);
  const io = adapters ?? defaultAdapters(auth);

  // 1. Evidence: searches per plan (none in dossier-only), deduped by URL.
  const seen = new Set<string>();
  const raw: SourceManifestEntry[] = [];
  for (const step of plan) {
    for (const query of step.queries) {
      const results = await io.search(query, SEARCH_LIMIT);
      for (const r of results) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        raw.push({
          ref: "",
          title: r.title || r.url,
          url: r.url,
          publishedAt: r.publishedAt ?? null,
          retrievedAt: new Date().toISOString(),
          query,
        });
      }
    }
  }

  // 2. Dossier-only evidence comes from the pinned dossier sources. Its own
  // short transaction: the model calls below are provider calls and must
  // never hold a pooled connection open (lib/db-transaction.ts rule).
  if (mode === "dossier-only") {
    await withTransaction(async (tx) => {
      raw.push(...(await loadDossierManifest(tx, auth, input.dossierId!)));
    });
  }
  const kept = filterByCutoff(raw, cutoff);
  const manifest = kept.map((e, i) => ({ ...e, ref: `S${i + 1}` }));

  // 3. Draft each narrative section with citations into the manifest. No
  // transaction open here: io.complete is a provider call per section.
  const draft = async (): Promise<{ written: string[]; grounded: number; gaps: number }> => {
    const written: string[] = [];
    let grounded = 0;
    let gaps = 0;
    for (const section of REPORT_SECTIONS) {
      if (section === "Source manifest") continue;
      let body: string;
      if (!manifest.length) {
        body = sectionOrPlaceholder(section, "", 0);
      } else if (section === "Financial trend table") {
        // Step 5: structured KPI extraction. A JSON answer is validated and
        // rendered as the trend table; a prose answer (older fakes, a model
        // that ignores the format) takes the ordinary citation-checked path.
        const answer = await io.complete(section, buildKpiPrompt(input, manifest));
        const parsed = parseKpiRows(answer);
        if (parsed === null) {
          body = sectionOrPlaceholder(section, answer, manifest.length);
        } else {
          const { rows, dropped } = validateKpiRows(parsed, manifest.length);
          body = rows.length ? renderKpiTable(rows, dropped) : sectionOrPlaceholder(section, "", manifest.length);
        }
      } else {
        body = sectionOrPlaceholder(section, await io.complete(section, buildSectionPrompt(input, section, manifest)), manifest.length);
      }
      if (body.startsWith("> [!NOTE]")) gaps += 1;
      else grounded += 1;
      written.push(`## ${section}\n\n${body}`);
    }
    return { written, grounded, gaps };
  };
  const { written, grounded, gaps } = await draft();

  return withTransaction(async (tx) => {
    // 4. The manifest renders as its own section; the report stands alone.
    const manifestLines = manifest.length
      ? manifest.map((m) => `- [${m.ref}] ${m.title} - ${m.url}${m.publishedAt ? ` (published ${m.publishedAt})` : " (undated)"} (retrieved ${m.retrievedAt.slice(0, 10)})`)
      : ["- No sources were gathered for this report."];
    if (mode === "dossier-only") manifestLines.unshift("- Dossier-only mode: no web search was run; only pinned dossier sources appear below.");
    if (cutoff) manifestLines.unshift(`- Historical mode: sources published after ${input.asOfDate} were excluded.`);
    const markdown = [
      `# ${input.companyName.trim()}: a business case study`,
      "",
      `_Mode: ${mode}. Scenarios below are hypotheses, not predictions or investment advice._`,
      "",
      ...written,
      "",
      "## Source manifest",
      "",
      ...manifestLines,
    ].join("\n");

    // 5. Persist: artifact + immutable version + source rows + audit + outbox.
    const title = `${input.companyName.trim()} case study`;
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "runCompanyResearch", ...input }, async () => {
      const [artifact] = await tx
        .insert(artifacts)
        .values({ workspaceId: auth.workspaceId, kind: "report", status: "generated", title, createdBy: auth.userId, updatedBy: auth.userId })
        .returning({ id: artifacts.id });
      const [version] = await tx
        .insert(artifactVersions)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: artifact.id,
          versionNumber: 1,
          content: { text: markdown },
          plainText: markdown,
          reason: "created",
          createdBy: auth.userId,
        })
        .returning({ id: artifactVersions.id });
      await tx.update(artifacts).set({ currentVersionId: version.id, embedError: null }).where(eq(artifacts.id, artifact.id));
      for (const m of manifest) {
        await tx.insert(sources).values({
          workspaceId: auth.workspaceId,
          kind: "company-research",
          title: m.title,
          url: m.url,
          metadata: { query: m.query, publishedAt: m.publishedAt, artifactId: artifact.id },
          createdBy: auth.userId,
          updatedBy: auth.userId,
        });
      }
      await recordAudit(
        auth,
        { action: "research.company.completed", subjectType: "artifact", subjectId: artifact.id, summary: `Company research on "${input.companyName.trim()}" (${mode}, ${manifest.length} sources, ${grounded} grounded / ${gaps} gap sections)`, metadata: { mode, manifestSize: manifest.length, groundedSections: grounded, gapSections: gaps, asOfDate: input.asOfDate ?? null } },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "research.company.completed", payload: { artifactId: artifact.id, mode, manifestSize: manifest.length } });
      return { artifactId: artifact.id, versionId: version.id };
    });
    return { ...value, title, manifestSize: manifest.length, groundedSections: grounded, gapSections: gaps, replayed };
  });
}
