import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db as defaultDb } from "@/lib/db";
import { taxonomyNodes } from "./schema";

/*
 * The knowledge taxonomy catalog (ASH-272): the canonical labels the Jev
 * capture classifier may use, ported from the alfred donor's master ontology
 * (frozen, read-only). Three levels - domain (L1) -> subdomain (L2) ->
 * microtopic (L3). The donor's discipline is the contract: a classifier
 * matches canonical labels case-insensitively and preserves their casing,
 * returns null when nothing fits, and NEVER invents a label. Here that rule
 * is structural: resolveTaxonomyPath is the only write-side validation, so a
 * hallucinated slug is a rejected write, not a data bug.
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
  // L1 domains (10).
  { slug: "ai", displayName: "AI", level: 1, parentSlug: null, description: "Machine learning, models, and the industry around them.", sortOrder: 10 },
  { slug: "system-design", displayName: "System design", level: 1, parentSlug: null, description: "Architecture, infrastructure, and how software systems are built.", sortOrder: 20 },
  { slug: "finance", displayName: "Finance", level: 1, parentSlug: null, description: "Markets, money, accounting, and financial instruments.", sortOrder: 30 },
  { slug: "startups", displayName: "Startups", level: 1, parentSlug: null, description: "Founding, funding, and operating early-stage companies.", sortOrder: 40 },
  { slug: "investing", displayName: "Investing", level: 1, parentSlug: null, description: "Allocating capital: theses, portfolios, and deals.", sortOrder: 50 },
  { slug: "writing", displayName: "Writing", level: 1, parentSlug: null, description: "The craft and practice of writing.", sortOrder: 60 },
  { slug: "politics", displayName: "Politics", level: 1, parentSlug: null, description: "Government, policy, and political analysis.", sortOrder: 70 },
  { slug: "movies-pop-culture", displayName: "Movies & pop culture", level: 1, parentSlug: null, description: "Film, TV, music, and internet culture.", sortOrder: 80 },
  { slug: "philosophy", displayName: "Philosophy", level: 1, parentSlug: null, description: "Ideas, ethics, and schools of thought.", sortOrder: 90 },
  { slug: "productivity-career", displayName: "Productivity & career", level: 1, parentSlug: null, description: "Work habits, career growth, and personal effectiveness.", sortOrder: 100 },
  // L2 subdomains (3) with their L3 microtopics (9): the donor's documented example chains.
  { slug: "llms", displayName: "LLMs", level: 2, parentSlug: "ai", description: "Large language models: architecture, training, inference.", sortOrder: 11 },
  { slug: "databases", displayName: "Databases", level: 2, parentSlug: "system-design", description: "Storage engines, query processing, and data systems.", sortOrder: 21 },
  { slug: "markets", displayName: "Markets", level: 2, parentSlug: "finance", description: "How securities and rates trade and are priced.", sortOrder: 31 },
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
 */
export async function seedTaxonomyCatalog(
  workspaceId: string,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
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

