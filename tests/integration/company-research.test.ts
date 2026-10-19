import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts, dossiers, dossierSources, sources } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-114 orchestration against a real workspace: the report lands as a
 * versioned report artifact with one sources row per manifest entry, the same
 * idempotency key replays instead of duplicating, and dossier-only mode reads
 * the pinned dossier sources without ever calling search.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let research: typeof import("@/domains/knowledge/company-research");
const SECTION_COUNT = 10; // REPORT_SECTIONS length, asserted in the unit suite

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  research = await import("@/domains/knowledge/company-research");
});

afterAll(async () => {
  await handle?.client.end();
});

const fakeSearch = (urls: string[]) => async () =>
  urls.map((url, i) => ({ title: `Source ${url}`, url, publishedAt: `2025-0${(i % 9) + 1}-15` }));

const groundedComplete = async () => "The evidence supports this section [S1].";

suite("runCompanyResearch", () => {
  it("persists a report artifact, source rows, and replays on the same key", async () => {
    const seeded = await seedWorkspace(db, `research-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const adapters = { search: fakeSearch(["https://example.com/a", "https://example.com/b"]), complete: groundedComplete };

    const first = await research.runCompanyResearch(
      auth,
      { companyName: "Acme Corp", depth: "quick", idempotencyKey: crypto.randomUUID() },
      adapters,
    );
    expect(first.replayed).toBe(false);
    expect(first.manifestSize).toBeGreaterThan(0);
    expect(first.groundedSections).toBe(SECTION_COUNT - 1);
    expect(first.gapSections).toBe(0);

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, first.artifactId));
    expect(artifact.kind).toBe("report");
    expect(artifact.status).toBe("generated");
    const sourceRows = await db.select().from(sources).where(eq(sources.workspaceId, auth.workspaceId));
    expect(sourceRows.length).toBe(first.manifestSize);

    // Replay: same key returns the stored result without a second artifact.
    const key = crypto.randomUUID();
    const a = await research.runCompanyResearch(auth, { companyName: "Acme Corp", depth: "quick", idempotencyKey: key }, adapters);
    const b = await research.runCompanyResearch(auth, { companyName: "Acme Corp", depth: "quick", idempotencyKey: key }, adapters);
    expect(b.artifactId).toBe(a.artifactId);
    expect(b.replayed).toBe(true);
  });

  it("dossier-only mode never searches and grounds the report in pinned sources", async () => {
    const seeded = await seedWorkspace(db, `research-dossier-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const [dossier] = await db
      .insert(dossiers)
      .values({ workspaceId: auth.workspaceId, title: "Acme dossier", researchQuestion: "How does Acme make money?", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    const [source] = await db
      .insert(sources)
      .values({ workspaceId: auth.workspaceId, kind: "web", title: "Acme about page", url: "https://acme.example/about", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    await db.insert(dossierSources).values({ workspaceId: auth.workspaceId, dossierId: dossier.id, sourceId: source.id });

    let searched = 0;
    const result = await research.runCompanyResearch(
      auth,
      { companyName: "Acme Corp", mode: "dossier-only", dossierId: dossier.id },
      { search: async () => { searched += 1; return []; }, complete: groundedComplete },
    );
    expect(searched).toBe(0);
    expect(result.manifestSize).toBe(1);
    expect(result.groundedSections).toBe(SECTION_COUNT - 1);
  });

  it("a section the model cannot ground is a recorded gap, not prose", async () => {
    const seeded = await seedWorkspace(db, `research-gap-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const result = await research.runCompanyResearch(
      auth,
      { companyName: "Acme Corp", depth: "quick" },
      { search: fakeSearch(["https://example.com/c"]), complete: async () => "Confident but unsourced paragraph." },
    );
    expect(result.gapSections).toBe(SECTION_COUNT - 1);
    expect(result.groundedSections).toBe(0);
  });
});
