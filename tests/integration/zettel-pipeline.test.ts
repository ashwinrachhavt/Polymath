import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts, artifactVersions, documents, documentExtractions } from "@/domains/knowledge/schema";
import { eq } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Task 18 pipeline: a long source is read section by section in full,
 * an over-cap source reports what was not read, and a quote that is not
 * verbatim in its own section never becomes a proposal.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

/** A 30,000-character unheaded source; paragraphs give the splitter cut points. */
const LONG_TEXT = Array.from({ length: 640 }, () => "A body sentence about rent for the paragraph.").join("\n\n");

/** Seeds a fresh workspace whose document carries a succeeded extraction with `text`. */
async function seedDocument(label: string, text: string) {
  const db = holder.db!;
  const seed = await seedWorkspace(db, `zpipe-${label}-${Date.now()}`);
  const auth = ownerAuth(seed.userId, seed.workspaceId);
  const [document] = await db
    .insert(documents)
    .values({
      workspaceId: auth.workspaceId,
      title: "Long lease",
      mimeType: "text/plain",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  await db.insert(documentExtractions).values({
    workspaceId: auth.workspaceId,
    documentId: document.id,
    contentHash: crypto.randomUUID(),
    status: "succeeded",
    text,
    extractor: "fixture@1",
  });
  return { auth, documentId: document.id };
}

suite("the zettelization pipeline (real Postgres)", () => {
  /** Seeds an artifact whose current version's plain text is `text` (Task 18's artifact path). */
  async function seedTextArtifact(label: string, text: string) {
    const db = holder.db!;
    const seed = await seedWorkspace(db, `zpipe-art-${label}-${Date.now()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
    const [artifact] = await db
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "note",
        title: "Lease notes",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id, version: artifacts.version });
    const [version] = await db
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: artifact.id,
        versionNumber: 1,
        content: { format: "markdown", text },
        plainText: text,
        reason: "created",
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
    return { auth, artifactId: artifact.id };
  }

  it("drops a candidate whose quote is verbatim elsewhere but not in its own section", async () => {
    const sectionTwoPassage = "Rent is due on the first of each month.";
    const text = `## Section 1\nA first section about the porch, with no rent in it.\n\n## Section 2\n${sectionTwoPassage}`;
    const { auth, artifactId } = await seedTextArtifact("reach", text);
    const { proposeZettels } = await import("@/domains/knowledge/zettels");

    // Section 1's candidate reaches across the document for a passage only
    // section 2 contains. Evidence is per-section, so it must be dropped
    // even though the quote is verbatim in the artifact as a whole.
    const extractor = {
      name: "fake",
      extract: async (section: string) =>
        section.includes("Section 1") ? [{ title: "Reach", claim: "A claim", quote: sectionTwoPassage }] : [],
    };
    const { proposals } = await proposeZettels(auth, { sourceArtifactId: artifactId, extractor });
    expect(proposals).toEqual([]);
  });

  it("reads every section of a 30,000-character document", async () => {
    const { auth, documentId } = await seedDocument("full", LONG_TEXT);
    expect(LONG_TEXT.length).toBeGreaterThanOrEqual(30_000);

    // A fake extractor that records the text it was handed, one call per section.
    const seen: string[] = [];
    const extractor = {
      name: "fake",
      extract: async (text: string) => {
        seen.push(text);
        return [] as never[];
      },
    };
    const { proposeZettels } = await import("@/domains/knowledge/zettels");
    const result = await proposeZettels(auth, { documentId, extractor });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join("")).not.toContain("…"); // nothing sliced by the extractor's cap
    expect(Math.max(...seen.map((t) => t.length))).toBeLessThanOrEqual(12_000);
    // Full read: the sections tile the whole source exactly.
    expect(seen.reduce((n, t) => n + t.length, 0)).toBe(LONG_TEXT.length);
    expect(result.readChars).toBe(LONG_TEXT.length);
    expect(result.unreadChars).toBe(0);
  });

  it("reports unread characters for a source over the section cap", async () => {
    // Twenty-five headed sections of ~3,300 characters: thirteen past the cap of twelve.
    const text = Array.from({ length: 25 }, (_, i) => `## Section ${i}\n\n${"Body text. ".repeat(300)}\n`).join("\n");
    const { auth, documentId } = await seedDocument("over", text);
    const extractor = { name: "fake", extract: async () => [] as never[] };
    const { proposeZettels } = await import("@/domains/knowledge/zettels");
    const result = await proposeZettels(auth, { documentId, extractor });

    expect(result.unreadChars).toBeGreaterThan(0);
    expect(result.unreadSections).toBe(13);
  });

  it("drops a candidate whose quote is not verbatim in its own section", async () => {
    const verbatimPassage = "The tenant pays monthly rent of twelve hundred dollars.";
    const text = `Preamble sentence one.\n\n${verbatimPassage}\n\nClosing paragraph with other words.`;
    const { auth, documentId } = await seedDocument("verbatim", text);
    const extractor = {
      name: "fake",
      extract: async () => [
        { title: "Real", claim: "A claim", quote: verbatimPassage },
        { title: "Invented", claim: "A claim", quote: "this sentence is not in the document anywhere at all" },
      ],
    };
    const { proposeZettels } = await import("@/domains/knowledge/zettels");
    const { proposals, readChars } = await proposeZettels(auth, { documentId, extractor });

    expect(proposals.map((p) => p.title)).toEqual(["Real"]);
    expect(readChars).toBe(text.length);
  });
});
