import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db as defaultDb } from "@/lib/db";
import { taxonomyNodes } from "./schema";

/*
 * The knowledge taxonomy catalog (ASH-272): the canonical labels the Jev
 * capture classifier may use - the old Neuralflow product's tag ontology
 * (22 canonical topics, frozen, read-only). Three levels - domain (L1) ->
 * subdomain (L2) -> microtopic (L3). The classifier discipline is the
 * contract: a classifier matches canonical labels case-insensitively and
 * preserves their casing, returns null when nothing fits, and NEVER invents
 * a label. Here that rule is structural: resolveTaxonomyPath is the only
 * write-side validation, so a hallucinated slug is a rejected write, not a
 * data bug.
 *
 * The alfred taxonomy was user-grown at runtime; Polymath v1 ships the seed
 * only (SEED_TAXONOMY below). When a node-management surface arrives it
 * brings its own write seam; nothing here anticipates one.
 */

export type TaxonomyNode = typeof taxonomyNodes.$inferSelect;

/** The seed catalog. Each description is the selection criterion the classifier's question criteria quote. */
export const SEED_TAXONOMY: ReadonlyArray<{
  slug: string;
  displayName: string;
  level: 1 | 2 | 3;
  parentSlug: string | null;
  description: string;
  sortOrder: number;
}> = [
  // L1 domains (22): the Neuralflow product's tag ontology, ported wholesale.
  { slug: "planning-strategy", displayName: "Planning & Strategy", level: 1, parentSlug: null, description: "Goals, roadmaps, prioritization, and how work is planned and sequenced.", sortOrder: 10 },
  { slug: "product-management", displayName: "Product Management", level: 1, parentSlug: null, description: "Product decisions: requirements, features, user problems, and shipped scope.", sortOrder: 20 },
  { slug: "coding-development", displayName: "Coding & Development", level: 1, parentSlug: null, description: "Writing, reviewing, or refactoring code and building software features.", sortOrder: 30 },
  { slug: "devops-infra", displayName: "DevOps & Infra", level: 1, parentSlug: null, description: "Deployment, infrastructure, CI/CD, cloud resources, and environment setup.", sortOrder: 40 },
  { slug: "bugfix-debugging", displayName: "Bugfix & Debugging", level: 1, parentSlug: null, description: "Diagnosing failures, errors, and unexpected behavior, and the fixes for them.", sortOrder: 50 },
  { slug: "qa-testing", displayName: "QA & Testing", level: 1, parentSlug: null, description: "Test plans, suites, coverage, and verifying software behaves as specified.", sortOrder: 60 },
  { slug: "design-ux", displayName: "Design & UX", level: 1, parentSlug: null, description: "Interfaces, visual design, usability, and how an experience feels to use.", sortOrder: 70 },
  { slug: "writing-documentation", displayName: "Writing & Documentation", level: 1, parentSlug: null, description: "Prose artifacts: docs, guides, specs, and written communication of record.", sortOrder: 80 },
  { slug: "data-analytics", displayName: "Data & Analytics", level: 1, parentSlug: null, description: "Queries, dashboards, metrics, and drawing conclusions from data.", sortOrder: 90 },
  { slug: "research-learning", displayName: "Research & Learning", level: 1, parentSlug: null, description: "Open-ended investigation and study to understand a topic or answer a question.", sortOrder: 100 },
  { slug: "communication-meetings", displayName: "Communication & Meetings", level: 1, parentSlug: null, description: "Emails, messages, meeting notes, and coordination between people.", sortOrder: 110 },
  { slug: "customer-support", displayName: "Customer Support", level: 1, parentSlug: null, description: "User-reported issues, tickets, and helping customers use the product.", sortOrder: 120 },
  { slug: "sales-outreach", displayName: "Sales & Outreach", level: 1, parentSlug: null, description: "Prospecting, pipelines, deals, and outreach to potential customers.", sortOrder: 130 },
  { slug: "marketing-growth", displayName: "Marketing & Growth", level: 1, parentSlug: null, description: "Campaigns, positioning, acquisition channels, and audience growth.", sortOrder: 140 },
  { slug: "finance-admin", displayName: "Finance & Admin", level: 1, parentSlug: null, description: "Budgets, invoices, accounting, payroll, and administrative paperwork.", sortOrder: 150 },
  { slug: "legal-compliance", displayName: "Legal & Compliance", level: 1, parentSlug: null, description: "Contracts, terms, regulations, privacy policies, and legal review.", sortOrder: 160 },
  { slug: "operations-maintenance", displayName: "Operations & Maintenance", level: 1, parentSlug: null, description: "Routine upkeep: maintenance schedules, vendors, and day-to-day operations.", sortOrder: 170 },
  { slug: "security-privacy", displayName: "Security & Privacy", level: 1, parentSlug: null, description: "Vulnerabilities, access control, threat models, and handling of personal data.", sortOrder: 180 },
  { slug: "personal-wellness", displayName: "Personal & Wellness", level: 1, parentSlug: null, description: "Health, fitness, habits, and personal life outside of work.", sortOrder: 190 },
  { slug: "home-errands", displayName: "Home & Errands", level: 1, parentSlug: null, description: "Household tasks, errands, purchases, and appointments for daily life.", sortOrder: 200 },
  { slug: "career-growth", displayName: "Career & Growth", level: 1, parentSlug: null, description: "Job hunting, promotions, skills development, and professional trajectory.", sortOrder: 210 },
  { slug: "general", displayName: "General", level: 1, parentSlug: null, description: "Anything that fits none of the other domains; the fallback when no specific topic applies.", sortOrder: 220 },
  // L2 subdomains (3) with their L3 microtopics (9): the documented example chains,
  // re-parented to the Neuralflow domains they best classify under.
  { slug: "llms", displayName: "LLMs", level: 2, parentSlug: "coding-development", description: "Large language models: architecture, training, inference.", sortOrder: 31 },
  { slug: "databases", displayName: "Databases", level: 2, parentSlug: "coding-development", description: "Storage engines, query processing, and data systems.", sortOrder: 32 },
  { slug: "markets", displayName: "Markets", level: 2, parentSlug: "finance-admin", description: "How securities and rates trade and are priced.", sortOrder: 151 },
  { slug: "self-attention", displayName: "Self-attention", level: 3, parentSlug: "llms", description: "The attention mechanism at the core of transformers.", sortOrder: 1 },
  { slug: "kv-cache", displayName: "KV cache", level: 3, parentSlug: "llms", description: "Inference-time caching of key/value tensors.", sortOrder: 2 },
  { slug: "quantization", displayName: "Quantization", level: 3, parentSlug: "llms", description: "Reducing model precision for cheaper inference.", sortOrder: 3 },
  { slug: "lsm-trees", displayName: "LSM trees", level: 3, parentSlug: "databases", description: "Log-structured merge-tree storage engines.", sortOrder: 1 },
  { slug: "mvcc", displayName: "MVCC", level: 3, parentSlug: "databases", description: "Multi-version concurrency control.", sortOrder: 2 },
  { slug: "sharding", displayName: "Sharding", level: 3, parentSlug: "databases", description: "Horizontal partitioning of data across nodes.", sortOrder: 3 },
  { slug: "equities", displayName: "Equities", level: 3, parentSlug: "markets", description: "Stocks and equity instruments.", sortOrder: 1 },
  { slug: "bonds", displayName: "Bonds", level: 3, parentSlug: "markets", description: "Fixed-income instruments.", sortOrder: 2 },
  { slug: "yield-curve", displayName: "Yield curve", level: 3, parentSlug: "markets", description: "Term structure of interest rates.", sortOrder: 3 },
];

/**
 * Idempotently seed the catalog for one workspace. Called at workspace
 * provisioning and by scripts/seed-taxonomy.ts; a re-run changes nothing
 * (upsert keyed on the workspace+slug unique constraint, content stable).
 *
 * Retirement contract: any taxonomy node in this workspace whose slug is NOT
 * in SEED_TAXONOMY is deleted before the upsert, children (L3) before parents
 * (L2 then L1) so no dangling parentSlug survives. Safe because
 * captures.domain and the classification proposals store slugs as text with
 * no foreign key into taxonomy_nodes - a retired slug in an old capture
 * degrades to an unresolvable label, not a broken reference.
 */
export async function seedTaxonomyCatalog(
  workspaceId: string,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  const seedSlugs = SEED_TAXONOMY.map((node) => node.slug);
  // Children before parents: reverse level order keeps every delete free of
  // child rows still pointing at the parent being removed.
  for (const level of [3, 2, 1] as const) {
    await database
      .delete(taxonomyNodes)
      .where(
        and(
          eq(taxonomyNodes.workspaceId, workspaceId),
          eq(taxonomyNodes.level, level),
          notInArray(taxonomyNodes.slug, seedSlugs),
        ),
      );
  }
  await database
    .insert(taxonomyNodes)
    .values(SEED_TAXONOMY.map((node) => ({ workspaceId, ...node })))
    .onConflictDoUpdate({
      target: [taxonomyNodes.workspaceId, taxonomyNodes.slug],
      set: {
        displayName: sql`excluded.display_name`,
        level: sql`excluded.level`,
        parentSlug: sql`excluded.parent_slug`,
        description: sql`excluded.description`,
        sortOrder: sql`excluded.sort_order`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Validate a [domain, subdomain, microtopic] chain against the live catalog.
 * Returns the resolved nodes, or null when any slug is missing, archived, or
 * hangs under the wrong parent. The classifier calls this before writing:
 * a hallucinated label is a rejected write, never a stored one.
 */
export async function resolveTaxonomyPath(
  auth: Pick<AuthContext, "workspaceId">,
  input: { slugs: string[] },
): Promise<TaxonomyNode[] | null> {
  const { slugs } = input;
  if (slugs.length < 1 || slugs.length > 3) return null;
  const rows = await defaultDb
    .select()
    .from(taxonomyNodes)
    .where(and(eq(taxonomyNodes.workspaceId, auth.workspaceId), isNull(taxonomyNodes.archivedAt)));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const path: TaxonomyNode[] = [];
  let parentSlug: string | null = null;
  for (const [index, slug] of slugs.entries()) {
    const node = bySlug.get(slug);
    if (!node) return null;
    if (node.level !== index + 1) return null;
    if (node.parentSlug !== parentSlug) return null;
    path.push(node);
    parentSlug = node.slug;
  }
  return path;
}

