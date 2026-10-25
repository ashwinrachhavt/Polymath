import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { companies, contactCompanies, contacts } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { fetchPageForAgent } from "@/domains/knowledge/web-fetch";
import { searchWebForAgent } from "@/domains/knowledge/web-search";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { artifactLinks, artifacts, artifactVersions, sources } from "./schema";

/*
 * Profile research (ASH-291): the research workflow embedded on a company or
 * person profile. One bounded web pass produces a grounded card set:
 *
 *  - Company: crawl the record's homepage and about page, search recent news.
 *  - Person: person-shaped searches (identity plus the requested focus), with
 *    people-specific card kinds and focus buttons on the profile.
 *
 * The contract that matters is honesty, same as the case-study engine's:
 * every card cites manifest sources as [S#]; a card whose citations do not
 * resolve into the manifest is dropped and recorded as a gap, never smoothed
 * into confident unsourced prose. The pass is bounded (2 page fetches or 2
 * searches, one generation call) so a click has a predictable cost; searches
 * run through the quota-gated workspace web-search seam, never a raw key.
 *
 * The model sees web content marked as data; the card set never leaves the
 * workspace, so this is an owner-invoked read-then-write, not a proposal.
 *
 * Generation goes through the generation seam; search and fetch through
 * injected adapters so tests drive fakes. When the e2e fixture environment is
 * selected (GENERATION_PROVIDER=fixture - the explicit no-spend signal the CI
 * journeys already use), the default search/fetch adapters answer
 * deterministically from fixture data instead of the network, so the whole
 * journey stays hermetic. No deployment drifts into this: it is keyed on the
 * same explicit env choice, never on key detection.
 */

export class ProfileResearchError extends Error {
  readonly code = "profile_research";
  constructor(message: string) {
    super(message);
    this.name = "ProfileResearchError";
  }
}

export class ProfileResearchUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileResearchUnusableAnswerError";
  }
}

/* ------------------------------------------------------------------ types */

export const COMPANY_CARD_KINDS = ["overview", "offerings", "news", "watch"] as const;
export const CONTACT_CARD_KINDS = ["background", "role", "mentions", "talking-points"] as const;
export const CONTACT_RESEARCH_FOCI = ["profile", "background", "mentions", "talking-points"] as const;

export type CompanyCardKind = (typeof COMPANY_CARD_KINDS)[number];
export type ContactCardKind = (typeof CONTACT_CARD_KINDS)[number];
export type ContactResearchFocus = (typeof CONTACT_RESEARCH_FOCI)[number];

export const PROFILE_RESEARCH_LINK_LABEL = "Profile research";
export const PROFILE_RESEARCH_CONTENT_TYPE = "profile-research";
export const PROFILE_RESEARCH_SOURCE_KIND = "profile-research";

/** Bounded pass budgets: a click costs at most this, every time. */
export const COMPANY_MAX_FETCHES = 2;
export const COMPANY_MAX_SEARCHES = 1;
export const CONTACT_MAX_SEARCHES = 2;
export const PROFILE_SEARCH_LIMIT = 5;
export const PROFILE_MAX_CARDS = 6;
export const PROFILE_MAX_SNIPPET_CHARS = 900;
export const PROFILE_MAX_MANIFEST = 12;

export type ProfileManifestEntry = {
  ref: string;
  title: string;
  url: string;
  publishedAt: string | null;
  retrievedAt: string;
  snippet: string | null;
};

export type ProfileCard = {
  kind: string;
  title: string;
  body: string;
  /** Manifest ref numbers (1-based) backing this card. */
  citations: number[];
};

export type ProfileResearchAdapters = {
  search(query: string, limit: number): Promise<{ title: string; url: string; publishedAt: string | null; snippet?: string }[]>;
  fetchPage(url: string): Promise<{ title: string | null; url: string; markdown: string } | { error: string }>;
};

/* ------------------------------------------------------- evidence planning */

export type EvidenceStep =
  | { kind: "fetch"; url: string; purpose: string }
  | { kind: "search"; query: string; purpose: string };

/** Normalize a stored domain into a bare host; junk is a caller-visible error, not a silent skip. */
export function normalizeDomain(raw: string | null): string | null {
  if (!raw) return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new ProfileResearchError(`The company domain "${raw}" is not a usable host name.`);
  }
  return host;
}

/**
 * The company evidence plan, pure: homepage and about page when the record
 * carries a domain, plus one recent-news search. A company with no domain
 * plans zero fetches - the search-only path is a structural consequence of
 * there being nothing to crawl, not a flag.
 */
export function planCompanyEvidence(input: { name: string; domain: string | null }): EvidenceStep[] {
  const name = input.name.trim();
  if (!name) throw new ProfileResearchError("The company needs a name before it can be researched.");
  const steps: EvidenceStep[] = [];
  const host = normalizeDomain(input.domain);
  if (host) {
    steps.push(
      { kind: "fetch", url: `https://${host}/`, purpose: "homepage" },
      { kind: "fetch", url: `https://${host}/about`, purpose: "about page" },
    );
  }
  steps.push({ kind: "search", query: `"${name.replace(/"/g, "'")}" news`, purpose: "recent news" });
  return steps;
}

/**
 * The person evidence plan, pure: an identity search plus one shaped by the
 * requested focus. The default "profile" focus pairs identity with a recent
 * mentions search; the focused passes spend their second query on exactly the
 * button the owner pressed.
 */
export function planContactEvidence(input: {
  fullName: string;
  currentCompanyName: string | null;
  focus: ContactResearchFocus;
}): EvidenceStep[] {
  const name = input.fullName.trim();
  if (!name) throw new ProfileResearchError("The person needs a name before they can be researched.");
  const quoted = `"${name.replace(/"/g, "'")}"`;
  const company = input.currentCompanyName?.trim() ? ` "${input.currentCompanyName.trim().replace(/"/g, "'")}"` : "";
  const steps: EvidenceStep[] = [{ kind: "search", query: `${quoted}${company}`, purpose: "identity" }];
  switch (input.focus) {
    case "background":
      steps.push({ kind: "search", query: `${quoted}${company} bio OR background OR career`, purpose: "background" });
      break;
    case "mentions":
      steps.push({ kind: "search", query: `${quoted}${company} news OR interview OR talk`, purpose: "recent mentions" });
      break;
    case "talking-points":
      steps.push({ kind: "search", query: `${quoted}${company} writing OR podcast OR interests`, purpose: "talking points" });
      break;
    default:
      steps.push({ kind: "search", query: `${quoted}${company} news OR interview`, purpose: "recent mentions" });
  }
  return steps;
}

/* ------------------------------------------------------------- gathering */

async function gatherEvidence(steps: EvidenceStep[], io: ProfileResearchAdapters): Promise<ProfileManifestEntry[]> {
  const seen = new Set<string>();
  const raw: Omit<ProfileManifestEntry, "ref">[] = [];
  for (const step of steps) {
    if (step.kind === "fetch") {
      const page = await io.fetchPage(step.url);
      if ("error" in page || seen.has(page.url)) continue;
      seen.add(page.url);
      raw.push({
        title: page.title ?? page.url,
        url: page.url,
        publishedAt: null,
        retrievedAt: new Date().toISOString(),
        snippet: page.markdown.slice(0, PROFILE_MAX_SNIPPET_CHARS),
      });
    } else {
      const results = await io.search(step.query, PROFILE_SEARCH_LIMIT);
      for (const r of results) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        raw.push({
          title: r.title || r.url,
          url: r.url,
          publishedAt: r.publishedAt ?? null,
          retrievedAt: new Date().toISOString(),
          snippet: r.snippet?.slice(0, PROFILE_MAX_SNIPPET_CHARS) ?? null,
        });
      }
    }
  }
  return raw.slice(0, PROFILE_MAX_MANIFEST).map((e, i) => ({ ...e, ref: `S${i + 1}` }));
}

/* -------------------------------------------------------- model contract */

const cardSchema = (kinds: readonly string[]) =>
  z.object({
    kind: z.enum(kinds as [string, ...string[]]),
    title: z.string().trim().min(1).max(140),
    body: z.string().trim().min(1).max(1200),
    citations: z.array(z.number().int().min(1)).min(1).max(6),
  });

const answerSchema = (kinds: readonly string[]) =>
  z.object({ cards: z.array(cardSchema(kinds)).min(1).max(PROFILE_MAX_CARDS) });

/** Parse the model's JSON strictly; a malformed or over-cap answer is unusable, never partially applied. */
export function parseProfileResearchAnswer(text: string, kinds: readonly string[]): ProfileCard[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProfileResearchUnusableAnswerError("The model's answer was not JSON.");
  }
  const parsed = answerSchema(kinds).safeParse(raw);
  if (!parsed.success) {
    throw new ProfileResearchUnusableAnswerError("The model's answer did not match the card-set shape.");
  }
  return parsed.data.cards;
}

/**
 * Citation honesty: a card survives only when at least one citation resolves
 * into the manifest, and it keeps only the citations that do. Anything else
 * is a recorded gap - the profile shows the count, never the ungrounded text.
 */
export function groundCards(cards: ProfileCard[], manifestSize: number): { grounded: ProfileCard[]; gaps: number } {
  const grounded: ProfileCard[] = [];
  let gaps = 0;
  for (const card of cards) {
    const valid = [...new Set(card.citations.filter((n) => n >= 1 && n <= manifestSize))];
    if (valid.length === 0) gaps += 1;
    else grounded.push({ ...card, citations: valid });
  }
  return { grounded, gaps };
}

/* --------------------------------------------------------------- prompts */

const COMPANY_SYSTEM = `You write a company profile card set for the owner, grounded only in the source manifest given. Return JSON with exactly one key: {"cards": [{"kind": "overview"|"offerings"|"news"|"watch", "title": string, "body": string, "citations": [number]}]}.
"overview": what the company does and for whom. "offerings": products, pricing or positioning. "news": a recent development. "watch": a risk, caveat or open question worth tracking.
Every card's citations list the manifest source numbers (1-based) its claims rest on; a claim with no source does not belong in a card. Two to five cards. Plain sentences, no marketing voice. ${untrustedDataClauseJsonSafe("source manifest")}`;

const CONTACT_SYSTEM = `You write a person profile card set for the owner, grounded only in the source manifest given. Return JSON with exactly one key: {"cards": [{"kind": "background"|"role"|"mentions"|"talking-points", "title": string, "body": string, "citations": [number]}]}.
"background": career history and credentials. "role": what they do now. "mentions": something they said or that was said about them recently. "talking-points": a personalized angle for the owner's next conversation with them, grounded in the sources - propose, never invent commitments.
Identity caution: name matches are not proof; only attribute what the sources tie to this person. Every card's citations list the manifest source numbers (1-based) its claims rest on. Two to five cards. ${untrustedDataClauseJsonSafe("source manifest")}`;

function manifestPrompt(manifest: ProfileManifestEntry[]): string {
  if (!manifest.length) return "SOURCE MANIFEST: empty";
  const lines = manifest.map(
    (m) =>
      `[${m.ref}] ${m.title} - ${m.url}${m.publishedAt ? ` (published ${m.publishedAt})` : " (undated)"}${m.snippet ? `\n${m.snippet}` : ""}`,
  );
  return ["SOURCE MANIFEST:", ...lines].join("\n");
}

/* ------------------------------------------------------------ persistence */

const persistedCardSet = z.object({
  type: z.literal(PROFILE_RESEARCH_CONTENT_TYPE),
  subjectType: z.enum(["company", "contact"]),
  subjectId: z.string().uuid(),
  focus: z.string(),
  generatedAt: z.string(),
  proposer: z.string(),
  cards: z.array(
    z.object({
      kind: z.string(),
      title: z.string(),
      body: z.string(),
      citations: z.array(z.number().int()),
    }),
  ),
  gaps: z.number().int().min(0),
  manifest: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      url: z.string(),
      publishedAt: z.string().nullable(),
      retrievedAt: z.string(),
    }),
  ),
});

export type PersistedCardSet = z.infer<typeof persistedCardSet>;

/** The latest card set linked to a profile, or null when the record has never been researched. */
export async function latestProfileResearch(
  auth: AuthContext,
  input: { subjectType: "company" | "contact"; subjectId: string },
): Promise<PersistedCardSet | null> {
  const rows = await db
    .select({ content: artifactVersions.content, createdAt: artifacts.createdAt })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.targetType, input.subjectType),
        eq(artifactLinks.targetId, input.subjectId),
        eq(artifactLinks.label, PROFILE_RESEARCH_LINK_LABEL),
        sql`${artifactVersions.content}->>'type' = ${PROFILE_RESEARCH_CONTENT_TYPE}`,
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  if (!rows.length) return null;
  const parsed = persistedCardSet.safeParse(rows[0].content);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------- run */

export type ProfileResearchResult = {
  artifactId: string;
  cardCount: number;
  gaps: number;
  manifestSize: number;
  focus: string;
  replayed: boolean;
};

function fixtureAdapters(): ProfileResearchAdapters {
  // See the module header: this answers only under the explicit e2e fixture
  // environment so the pixel journeys need no network and no spend.
  const retrievedPages: Record<string, { title: string; markdown: string }> = {
    "https://example.com/": {
      title: "Example - spending analytics for small teams",
      markdown:
        "Example builds spending analytics for small finance teams. The product imports bank statements, categorizes transactions and shows burn by vendor. Pricing is per seat with a free tier for two seats.",
    },
    "https://example.com/about": {
      title: "About Example",
      markdown:
        "Example was founded in 2024 by Maya Chen and Luis Ortega. The team is eleven people in Portland. The company positions itself against spreadsheets, not against enterprise suites.",
    },
  };
  return {
    async search(query) {
      if (query.includes("news") || query.includes("interview")) {
        return [
          {
            title: "Example raises a seed round to grow spending analytics",
            url: "https://techblog.test/example-seed",
            publishedAt: "2026-10-02",
            snippet: "Example raised $4M led by North Peak to expand its spending analytics for small teams.",
          },
          {
            title: "Priya Nair on pricing analytics for small teams",
            url: "https://podcast.test/priya-nair-pricing",
            publishedAt: "2026-09-18",
            snippet: "Priya Nair argues small teams want pricing answers in the tool they already use, not another dashboard.",
          },
        ];
      }
      return [
        {
          title: "Priya Nair - Platform Lead at Example",
          url: "https://example.com/team/priya-nair",
          publishedAt: null,
          snippet: "Priya Nair leads the platform group at Example, owning pricing and billing infrastructure.",
        },
      ];
    },
    async fetchPage(url) {
      const page = retrievedPages[url];
      if (!page) return { error: "not found" };
      return { title: page.title, url, markdown: page.markdown };
    },
  };
}

function defaultAdapters(auth: AuthContext): ProfileResearchAdapters {
  if (process.env.GENERATION_PROVIDER === "fixture") return fixtureAdapters();
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
    async fetchPage(url) {
      const page = await fetchPageForAgent(auth, { url, maxChars: 8_000 });
      if (!page.ok) return { error: page.error };
      return { title: page.title, url: page.url, markdown: page.markdown };
    },
  };
}

async function persistCardSet(
  auth: AuthContext,
  input: {
    subjectType: "company" | "contact";
    subjectId: string;
    subjectName: string;
    focus: string;
    cards: ProfileCard[];
    gaps: number;
    manifest: ProfileManifestEntry[];
    proposer: string;
    idempotencyKey?: string;
  },
): Promise<{ artifactId: string; replayed: boolean }> {
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "runProfileResearch", ...input, manifest: undefined, cards: undefined }, async () => {
      const payload: PersistedCardSet = {
        type: PROFILE_RESEARCH_CONTENT_TYPE,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        focus: input.focus,
        generatedAt: new Date().toISOString(),
        proposer: input.proposer,
        cards: input.cards,
        gaps: input.gaps,
        manifest: input.manifest.map(({ ref, title, url, publishedAt, retrievedAt }) => ({ ref, title, url, publishedAt, retrievedAt })),
      };
      const plainText = [
        `Profile research: ${input.subjectName} (${input.focus})`,
        ...input.cards.map((c) => `${c.title}: ${c.body}`),
        ...input.manifest.map((m) => m.title),
      ].join("\n");
      const title = `Research: ${input.subjectName}`;
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
          content: payload,
          plainText,
          reason: "created",
          createdBy: auth.userId,
        })
        .returning({ id: artifactVersions.id });
      await tx.update(artifacts).set({ currentVersionId: version.id, embedError: null }).where(eq(artifacts.id, artifact.id));
      await tx
        .insert(artifactLinks)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: artifact.id,
          targetType: input.subjectType,
          targetId: input.subjectId,
          label: PROFILE_RESEARCH_LINK_LABEL,
          linkType: "reference",
        })
        .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
      for (const m of input.manifest) {
        await tx.insert(sources).values({
          workspaceId: auth.workspaceId,
          kind: PROFILE_RESEARCH_SOURCE_KIND,
          title: m.title,
          url: m.url,
          metadata: { publishedAt: m.publishedAt, retrievedAt: m.retrievedAt, artifactId: artifact.id },
          createdBy: auth.userId,
          updatedBy: auth.userId,
        });
      }
      await recordAudit(
        auth,
        {
          action: "research.profile.completed",
          subjectType: "artifact",
          subjectId: artifact.id,
          summary: `Profile research on "${input.subjectName}" (${input.subjectType}/${input.focus}, ${input.manifest.length} sources, ${input.cards.length} cards, ${input.gaps} gaps)`,
          metadata: { subjectType: input.subjectType, subjectId: input.subjectId, focus: input.focus, manifestSize: input.manifest.length, cards: input.cards.length, gaps: input.gaps, proposer: input.proposer },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({
        workspaceId: auth.workspaceId,
        topic: "research.profile.completed",
        payload: { artifactId: artifact.id, subjectType: input.subjectType, subjectId: input.subjectId, focus: input.focus },
      });
      return { artifactId: artifact.id };
    });
    return { artifactId: value.artifactId, replayed };
  });
}

async function runPass(
  auth: AuthContext,
  input: {
    subjectType: "company" | "contact";
    subjectId: string;
    subjectName: string;
    subjectLine: string;
    focus: string;
    kinds: readonly string[];
    system: string;
    steps: EvidenceStep[];
    idempotencyKey?: string;
  },
  deps?: { provider?: GenerationProvider; adapters?: ProfileResearchAdapters },
): Promise<ProfileResearchResult> {
  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    if (error instanceof GenerationUnconfiguredError) throw new ProfileResearchError(error.message);
    throw error;
  }
  const io = deps?.adapters ?? defaultAdapters(auth);

  const manifest = await gatherEvidence(input.steps, io);
  const prompt = [
    `SUBJECT: ${input.subjectLine}`,
    `Write the ${input.focus === "profile" ? "full profile" : `focused "${input.focus}"`} card set from these sources.`,
    "",
    manifestPrompt(manifest),
  ].join("\n");
  const out = await provider.generate({ system: input.system, prompt, json: true });
  const cards = parseProfileResearchAnswer(out.text, input.kinds);
  const { grounded, gaps } = groundCards(cards, manifest.length);

  const { artifactId, replayed } = await persistCardSet(auth, {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    focus: input.focus,
    cards: grounded,
    gaps,
    manifest,
    proposer: provider.name,
    idempotencyKey: input.idempotencyKey,
  });
  return { artifactId, cardCount: grounded.length, gaps, manifestSize: manifest.length, focus: input.focus, replayed };
}

/** Company pass: crawl homepage and about page, search recent news, propose the card set. */
export async function runCompanyProfileResearch(
  auth: AuthContext,
  input: { companyId: string; idempotencyKey?: string },
  deps?: { provider?: GenerationProvider; adapters?: ProfileResearchAdapters },
): Promise<ProfileResearchResult> {
  const [company] = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)))
    .limit(1);
  if (!company) throw new ProfileResearchError("No such company.");
  const steps = planCompanyEvidence(company);
  const host = normalizeDomain(company.domain);
  return runPass(
    auth,
    {
      subjectType: "company",
      subjectId: company.id,
      subjectName: company.name,
      subjectLine: `the company "${company.name.trim()}"${host ? ` (${host})` : ""}`,
      focus: "profile",
      kinds: COMPANY_CARD_KINDS,
      system: COMPANY_SYSTEM,
      steps,
      idempotencyKey: input.idempotencyKey,
    },
    deps,
  );
}

/** Person pass: identity plus focus-shaped searches, personalized card set. */
export async function runContactProfileResearch(
  auth: AuthContext,
  input: { contactId: string; focus?: ContactResearchFocus; idempotencyKey?: string },
  deps?: { provider?: GenerationProvider; adapters?: ProfileResearchAdapters },
): Promise<ProfileResearchResult> {
  const focus: ContactResearchFocus = input.focus ?? "profile";
  if (!CONTACT_RESEARCH_FOCI.includes(focus)) throw new ProfileResearchError(`Unknown research focus "${focus}".`);
  const [contact] = await db
    .select({ id: contacts.id, fullName: contacts.fullName, title: contacts.title })
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt)))
    .limit(1);
  if (!contact) throw new ProfileResearchError("No such contact.");
  const [current] = await db
    .select({ name: companies.name })
    .from(contactCompanies)
    .innerJoin(companies, eq(companies.id, contactCompanies.companyId))
    .where(and(eq(contactCompanies.contactId, contact.id), eq(contactCompanies.workspaceId, auth.workspaceId), eq(contactCompanies.isCurrent, true)))
    .limit(1);
  const steps = planContactEvidence({ fullName: contact.fullName, currentCompanyName: current?.name ?? null, focus });
  return runPass(
    auth,
    {
      subjectType: "contact",
      subjectId: contact.id,
      subjectName: contact.fullName,
      subjectLine: `the person "${contact.fullName.trim()}"${contact.title ? `, ${contact.title}` : ""}${current?.name ? ` at ${current.name}` : ""}`,
      focus,
      kinds: CONTACT_CARD_KINDS,
      system: CONTACT_SYSTEM,
      steps,
      idempotencyKey: input.idempotencyKey,
    },
    deps,
  );
}
