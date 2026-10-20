import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-184 zettel views: the read behind the cards/table/timeline/dictionary
 * tabs. pageZettelCards returns accepted cards with their source edge joined
 * in, filters by query and tag, and never returns proposed-but-unaccepted
 * zettels or plain notes.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extract = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extract }));
vi.mock("@/integrations/object-store/object-store", () => ({ readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { extractDocument } from "@/domains/knowledge/extraction";
import { createNote, setNoteTags } from "@/domains/knowledge/notes";
import { acceptZettel, pageZettelCards, proposeZettels, rejectZettel } from "@/domains/knowledge/zettels";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const TEXT = "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit until move out. Pets are not allowed without written consent.";
const Q1 = "The tenant pays monthly rent of twelve hundred dollars.";
const Q2 = "The landlord keeps the security deposit until move out.";
const extractor = (cands: Array<{ title: string; claim: string; quote: string }>): ZettelExtractor => ({
  name: "fake@1", extract: async () => cands,
});

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture"); });

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `zv-${crypto.randomUUID()}`), role: "owner" as const });
async function seedDoc(auth: { workspaceId: string; userId: string; role: "owner" }) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({ workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(), sizeBytes: 4, mimeType: "application/pdf" }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title: "lease", fileId: file.id, mimeType: "application/pdf" }).returning();
  extract.extract.mockResolvedValueOnce({ ok: true, text: TEXT, spans: [{ page: 1, start: 0, end: TEXT.length }], pageCount: 1, extractor: "fixture@1" });
  const r = await extractDocument(auth, { documentId: doc.id });
  if (!r.ok) throw new Error("seed failed");
  return doc;
}

suite("zettel card views (real Postgres)", () => {
  it("lists accepted cards with their source document, excerpt and tags", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    const [p1, p2] = await proposeZettels(auth, {
      documentId: doc.id,
      extractor: extractor([
        { title: "Monthly rent", claim: "Rent is $1,200 a month.", quote: Q1 },
        { title: "Deposit", claim: "The landlord holds the deposit.", quote: Q2 },
      ]),
    });
    const accepted = await acceptZettel(auth, { proposalId: p1.id });
    await rejectZettel(auth, { proposalId: p2.id });
    await createNote(auth, { title: "Monthly rent note", idempotencyKey: crypto.randomUUID() });

    const page = await pageZettelCards(auth, { limit: 10, offset: 0 });
    expect(page.total).toBe(1); // the rejected proposal and the plain note stay out
    const card = page.items[0];
    expect(card.id).toBe(accepted.artifactId);
    expect(card.title).toBe("Monthly rent");
    expect(card.excerpt).toContain("Rent is $1,200 a month.");
    expect(card.sourceDocumentId).toBe(doc.id);
    expect(card.sourceTitle).toBe("lease");
    expect(card.tags).toEqual([]);
  });

  it("filters by query and by tag", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    const [p1, p2] = await proposeZettels(auth, {
      documentId: doc.id,
      extractor: extractor([
        { title: "Monthly rent", claim: "Rent is $1,200 a month.", quote: Q1 },
        { title: "Deposit", claim: "The landlord holds the deposit.", quote: Q2 },
      ]),
    });
    const a = await acceptZettel(auth, { proposalId: p1.id });
    await acceptZettel(auth, { proposalId: p2.id });
    await setNoteTags(auth, { artifactId: a.artifactId, expectedVersion: 1, tags: ["Lease"], idempotencyKey: crypto.randomUUID() });

    const byQuery = await pageZettelCards(auth, { query: "deposit", limit: 10, offset: 0 });
    expect(byQuery.items.map((c) => c.title)).toEqual(["Deposit"]);

    const byTag = await pageZettelCards(auth, { tag: "lease", limit: 10, offset: 0 });
    expect(byTag.items.map((c) => c.title)).toEqual(["Monthly rent"]);
    expect(byTag.items[0].tags).toEqual(["lease"]);

    const all = await pageZettelCards(auth, { limit: 10, offset: 0 });
    expect(all.total).toBe(2);
  });
});
