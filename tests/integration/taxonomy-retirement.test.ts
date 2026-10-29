import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taxonomyNodes } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Same import discipline as jev-classify.test.ts: taxonomy.ts reaches
 * @/lib/db, so it is lazy-imported after makeTestDb points DATABASE_URL at
 * the scratch database. Skipped unless TEST_DATABASE_URL is set.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let seedTaxonomyCatalog: typeof import("@/domains/knowledge/taxonomy").seedTaxonomyCatalog;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ seedTaxonomyCatalog } = await import("@/domains/knowledge/taxonomy"));
});

afterAll(async () => {
  await handle?.client.end();
});

/** The old alfred L1 slugs the seed replaced. */
const RETIRED_L1 = [
  "ai",
  "system-design",
  "finance",
  "startups",
  "investing",
  "writing",
  "politics",
  "movies-pop-culture",
  "philosophy",
  "productivity-career",
];

suite("taxonomy retirement contract", () => {
  it("deletes this workspace's non-seed nodes and keeps re-parented seed children", async () => {
    const { workspaceId } = await seedWorkspace(db, `tax-retire-${Date.now()}`);

    await db.insert(taxonomyNodes).values([
      ...RETIRED_L1.map((slug, i) => ({
        workspaceId,
        slug,
        displayName: slug,
        level: 1 as const,
        parentSlug: null,
        description: `old domain ${slug}`,
        sortOrder: 1000 + i,
      })),
      // A child hanging under a retired L1 and one under a seed L1: both
      // must go (their parent is retired in the child's case; the second
      // proves retirement is slug-scoped, not level-scoped).
      {
        workspaceId,
        slug: "orphan-under-finance",
        displayName: "Orphan",
        level: 2 as const,
        parentSlug: "finance",
        description: null,
        sortOrder: 1,
      },
      {
        workspaceId,
        slug: "legacy-mvcc",
        displayName: "Legacy MVCC",
        level: 3 as const,
        parentSlug: "system-design",
        description: null,
        sortOrder: 1,
      },
    ]);

    await seedTaxonomyCatalog(workspaceId, db as never);

    const rows = await db
      .select()
      .from(taxonomyNodes)
      .where(eq(taxonomyNodes.workspaceId, workspaceId));
    const slugs = new Set(rows.map((row) => row.slug));

    for (const slug of RETIRED_L1) expect(slugs.has(slug)).toBe(false);
    expect(slugs.has("orphan-under-finance")).toBe(false);
    expect(slugs.has("legacy-mvcc")).toBe(false);

    expect(slugs.has("finance-admin")).toBe(true);
    expect(slugs.has("coding-development")).toBe(true);

    // The seed's re-parented microtopic survives with its new parentage.
    const mvcc = rows.find((row) => row.slug === "mvcc");
    expect(mvcc?.parentSlug).toBe("databases");
    expect(mvcc?.level).toBe(3);

    // No retired slug anywhere, at any level.
    expect(rows.every((row) => !RETIRED_L1.includes(row.slug))).toBe(true);
  });

  it("leaves a seed re-run untouched (idempotency still holds)", async () => {
    const { workspaceId } = await seedWorkspace(db, `tax-idem-${Date.now()}`);
    await seedTaxonomyCatalog(workspaceId, db as never);
    const before = await db
      .select()
      .from(taxonomyNodes)
      .where(eq(taxonomyNodes.workspaceId, workspaceId));
    await seedTaxonomyCatalog(workspaceId, db as never);
    const after = await db
      .select()
      .from(taxonomyNodes)
      .where(eq(taxonomyNodes.workspaceId, workspaceId));
    expect(after.map((r) => r.slug).sort()).toEqual(before.map((r) => r.slug).sort());
  });
});
