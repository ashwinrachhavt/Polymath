import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifactKind, artifactStatus, artifactVersions, artifacts, wikiPages } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { pageArtifacts } from "@/domains/knowledge/artifacts";
import { getWikiPageText } from "@/domains/knowledge/wiki";

/*
 * The /alfred/artifacts boundary (plan §5): the list holds kept outputs only.
 * Studio drafts and kept drafts, wiki pages and accepted zettels appear; a
 * person's plain note and a raw saved answer (both artifacts of kind "note"
 * with no wiki registry row) never do. The wiki kind filter reads the
 * registry join, because "wiki" is not a db kind.
 */

suite("pageArtifacts kept-outputs boundary (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;

  async function insertArtifact(input: {
    kind: (typeof artifactKind.enumValues)[number];
    status?: (typeof artifactStatus.enumValues)[number];
    title: string;
    text?: string;
    archived?: boolean;
  }): Promise<string> {
    const [row] = await holder.db!
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: input.kind,
        title: input.title,
        status: input.status ?? "reviewed",
        ...(input.archived ? { archivedAt: new Date() } : {}),
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    const [version] = await holder.db!
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: row.id,
        versionNumber: 1,
        content: { text: input.text ?? `${input.title} body` },
        plainText: input.text ?? `${input.title} body`,
        reason: "created",
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await holder.db!.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, row.id));
    return row.id;
  }

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `kept-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);

    await insertArtifact({ kind: "report", status: "draft", title: "Quarterly report draft" });
    await insertArtifact({ kind: "deck", title: "Launch deck" });
    await insertArtifact({ kind: "zettel", title: "Claim card" });
    const wikiId = await insertArtifact({ kind: "note", title: "Topic: research", text: "A wiki article body." });
    await holder.db!.insert(wikiPages).values({
      workspaceId: auth.workspaceId,
      role: "article",
      artifactId: wikiId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    await insertArtifact({ kind: "note", title: "Brain dump", text: "A human note body." });
    await insertArtifact({ kind: "note", status: "archived", title: "Discarded draft", archived: true });
    await insertArtifact({ kind: "report", status: "archived", title: "Discarded report", archived: true });
  });

  it("default view lists kept outputs and excludes plain notes and archived rows", async () => {
    if (!handle) return;
    const all: string[] = [];
    const page = await pageArtifacts(auth, { limit: 100, offset: 0 });
    all.push(...page.items.map((r) => r.title));
    expect(page.total).toBe(4);
    expect(all).toContain("Quarterly report draft");
    expect(all).toContain("Launch deck");
    expect(all).toContain("Claim card");
    expect(all).toContain("Topic: research");
    expect(all).not.toContain("Brain dump");
    expect(all).not.toContain("Discarded draft");
    expect(all).not.toContain("Discarded report");
  });

  it("wiki kind filter matches the registry, not artifacts.kind", async () => {
    if (!handle) return;
    const page = await pageArtifacts(auth, { kind: "wiki", limit: 100, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]!.title).toBe("Topic: research");
    expect(page.items[0]!.isWiki).toBe(true);
  });

  it("zettel kind filter returns the accepted card", async () => {
    if (!handle) return;
    const page = await pageArtifacts(auth, { kind: "zettel", limit: 100, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]!.title).toBe("Claim card");
  });

  it("status filter narrows to that status", async () => {
    if (!handle) return;
    const drafts = await pageArtifacts(auth, { status: "draft", limit: 100, offset: 0 });
    expect(drafts.items.map((r) => r.title)).toEqual(["Quarterly report draft"]);
    const reviewed = await pageArtifacts(auth, { status: "reviewed", limit: 100, offset: 0 });
    expect(reviewed.total).toBe(3);
  });

  it("an unknown kind or status from the URL filters nothing, not everything", async () => {
    if (!handle) return;
    const page = await pageArtifacts(auth, { kind: "memo", status: "published", limit: 100, offset: 0 });
    expect(page.total).toBe(4);
  });

  it("another workspace's artifacts never appear", async () => {
    if (!handle) return;
    const other = await seedWorkspace(handle.db, `kept-other-${Date.now()}`);
    await holder.db!.insert(artifacts).values({
      workspaceId: other.workspaceId,
      kind: "report",
      title: "Foreign report",
      status: "reviewed",
      createdBy: other.userId,
      updatedBy: other.userId,
    });
    const page = await pageArtifacts(auth, { limit: 100, offset: 0 });
    expect(page.items.map((r) => r.title)).not.toContain("Foreign report");
  });

  it("the wiki reader returns the registered page's current version, and never a plain note", async () => {
    if (!handle) return;
    // The wiki row seeded above is the only registry-claimed artifact.
    const wiki = await pageArtifacts(auth, { kind: "wiki", limit: 1, offset: 0 });
    const reader = await getWikiPageText(auth, wiki.items[0]!.id);
    expect(reader).toMatchObject({ title: "Topic: research", plainText: "A wiki article body.", versionNumber: 1 });
    // A plain note has no registry row: the reader returns null, so the
    // Artifacts link for a non-wiki row never points here in the first place.
    const plain = await pageArtifacts(auth, { kind: "zettel", limit: 1, offset: 0 });
    expect(await getWikiPageText(auth, plain.items[0]!.id)).toBeNull();
  });
});
