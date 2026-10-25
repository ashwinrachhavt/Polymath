import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { artifacts, artifactVersions, documents, projects, projectSources, files, sources } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-114 orchestration against a real workspace: the report lands as a
 * versioned report artifact with one sources row per manifest entry, the same
 * idempotency key replays instead of duplicating, and project-only mode reads
 * the pinned project sources without ever calling search.
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

  it("project-only mode never searches and grounds the report in pinned sources", async () => {
    const seeded = await seedWorkspace(db, `research-project-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const [project] = await db
      .insert(projects)
      .values({ workspaceId: auth.workspaceId, title: "Acme project", description: "How does Acme make money?", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    const [source] = await db
      .insert(sources)
      .values({ workspaceId: auth.workspaceId, kind: "web", title: "Acme about page", url: "https://acme.example/about", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    await db.insert(projectSources).values({ workspaceId: auth.workspaceId, projectId: project.id, sourceId: source.id });
    // A document-backed source (the product project's primary shape): blob -> file -> document, pinned to the same project.
    const [blob] = await db.insert(blobObjects).values({ workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(), sizeBytes: 4, mimeType: "application/pdf" }).returning();
    const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "acme-10k.pdf" }).returning();
    const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title: "Acme 10-K", fileId: file.id }).returning();
    const [docSource] = await db.insert(sources).values({ workspaceId: auth.workspaceId, kind: "document", title: "Acme 10-K", fileId: file.id, createdBy: auth.userId, updatedBy: auth.userId }).returning();
    await db.insert(projectSources).values({ workspaceId: auth.workspaceId, projectId: project.id, sourceId: docSource.id });
    void doc;

    let searched = 0;
    const result = await research.runCompanyResearch(
      auth,
      { companyName: "Acme Corp", mode: "dossier-only", dossierId: project.id },
      { search: async () => { searched += 1; return []; }, complete: groundedComplete },
    );
    expect(searched).toBe(0);
    // Both the URL source and the document-backed source are in the manifest.
    expect(result.manifestSize).toBe(2);
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

  it("renders the financial trend table from validated KPI rows and drops ungrounded ones", async () => {
    const seeded = await seedWorkspace(db, `research-kpi-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const kpiJson = JSON.stringify([
      { metric: "Revenue", period: "FY2025", value: "12.4B", currency: "USD", basis: "GAAP", source: "S1" },
      { metric: "free cash flow", period: "FY2025", value: "1.2B", source: "S2" },
      { metric: "revenue", period: "FY2025", value: "99B", source: "S9" }, // outside the manifest: dropped
    ]);
    const complete = async (section: string) => (section === "Financial trend table" ? kpiJson : "The evidence supports this section [S1].");
    const result = await research.runCompanyResearch(
      auth,
      { companyName: "Acme Corp", depth: "quick", idempotencyKey: crypto.randomUUID() },
      { search: fakeSearch(["https://example.com/a", "https://example.com/b"]), complete },
    );
    expect(result.gapSections).toBe(0);
    expect(result.groundedSections).toBe(SECTION_COUNT - 1);

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, artifact.currentVersionId!));
    const text = String(version.plainText);
    expect(text).toContain("| Metric | Period | Value | Currency | Basis | Source |");
    expect(text).toContain("| revenue | FY2025 | 12.4B | USD | GAAP | [S1] |");
    expect(text).toContain("| free cash flow | FY2025 | 1.2B | unspecified | unspecified | [S2] |");
    expect(text).not.toContain("99B"); // the ungrounded figure never reaches the report
    expect(text).toContain("1 reported figure could not be grounded");
  });
});
