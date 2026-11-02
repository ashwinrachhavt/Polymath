import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { documents, documentExtractions } from "@/domains/knowledge/schema";
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
