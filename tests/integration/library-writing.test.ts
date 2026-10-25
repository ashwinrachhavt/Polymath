import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Library-grounded writing (ASH-301), end to end against a scratch database:
 *  1. a draft is written only from retrieved sources, lands as a document
 *     artifact with the source list, and flags its unsupported paragraph;
 *  2. a library with nothing on the topic refuses before any write;
 *  3. an answer citing a source the search never retrieved writes nothing.
 *
 * Search and generation are injected; the real seams are agent-search and
 * integrations/generation/provider. Skipped unless TEST_DATABASE_URL points
 * at a migrated scratch database.
 */

const SOURCES = [
  { documentId: crypto.randomUUID(), title: "Pricing decision", text: "Decided: annual billing stays for the platform tier." },
  { documentId: crypto.randomUUID(), title: "Q3 planning", text: "The roadmap review moves to the last Friday of the quarter." },
];

const DRAFT = JSON.stringify({
  title: "Where pricing stands",
  paragraphs: [
    { text: "Annual billing stays for the platform tier.", citations: [1], needsCitation: false },
    { text: "Usage pricing is winning the market.", citations: [], needsCitation: true },
  ],
});

const mockProvider = { name: "test:mock", registryId: "mock", generate: async () => ({ text: DRAFT }) };
const mockSearch = async () => SOURCES;

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let writing: typeof import("@/domains/knowledge/library-writing");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  writing = await import("@/domains/knowledge/library-writing");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

suite("library writing", () => {
  it("drafts only from retrieved sources and flags the unsupported paragraph", async () => {
    const { auth } = await seed("writing-happy");

    const result = await writing.draftFromLibrary(auth, { topic: "pricing" }, { provider: mockProvider, search: mockSearch });

    expect(result.sourceCount).toBe(2);
    expect(result.flaggedCount).toBe(1);

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(artifact.kind).toBe("document");
    expect(artifact.title).toBe("Where pricing stands");

    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, artifact.currentVersionId!));
    // plainText is the stripped preview column; the markdown body lives in
    // the version's content.
    expect(version.plainText).toContain("[1]");
    expect(version.plainText).toContain("[citation needed]");
    expect(version.plainText).toContain("Sources");
    expect(version.plainText).not.toContain("##");
    expect(version.plainText).toContain("Pricing decision");
    const content = version.content as { kind?: string; text?: string };
    expect(content.kind).toBe("markdown");
    expect(content.text).toContain("## Sources");
    // One line per cited document, citation numbers preserved.
    expect(content.text).toContain("- [1] Pricing decision");
    expect(content.text).toContain("- [2] Q3 planning");
    // The body does not repeat the artifact title - the page H1 owns it.
    expect(content.text).not.toContain("# Where pricing stands");
  });

  it("refuses an empty library before any write", async () => {
    const { auth, workspaceId } = await seed("writing-empty");
    await expect(
      writing.draftFromLibrary(auth, { topic: "astronomy" }, { provider: mockProvider, search: async () => [] }),
    ).rejects.toThrowError(/nothing on "astronomy"/);
    expect(await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("writes nothing when the model invents a source", async () => {
    const { auth, workspaceId } = await seed("writing-invented");
    const invented = {
      ...mockProvider,
      generate: async () => ({
        text: JSON.stringify({ title: "T", paragraphs: [{ text: "Cites thin air.", citations: [7], needsCitation: false }] }),
      }),
    };
    await expect(
      writing.draftFromLibrary(auth, { topic: "pricing" }, { provider: invented, search: mockSearch }),
    ).rejects.toThrowError(/never retrieved/);
    expect(await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(0);
  });
});
