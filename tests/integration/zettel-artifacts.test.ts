import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import {
  artifactLinks,
  artifacts,
  artifactVersions,
  claimEvidence,
  documents,
  files,
  zettelProposals,
} from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-174 / ASH-184: accepting a zettel proposal creates the zettel card as a
 * first-class artifact (kind "zettel") with a `source` edge back to its
 * document, so a source decomposes into cards that live in the same link
 * graph as user-written notes.
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
import { createNote, listNoteBacklinks, listNoteOutlinks, listNoteSources, autosaveNoteDraft } from "@/domains/knowledge/notes";
import { acceptZettel, proposeZettels } from "@/domains/knowledge/zettels";
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

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `za-${crypto.randomUUID()}`), role: "owner" as const });
async function seed(auth: { workspaceId: string; userId: string }) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({ workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(), sizeBytes: 4, mimeType: "application/pdf" }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title: "lease", fileId: file.id, mimeType: "application/pdf" }).returning();
  extract.extract.mockResolvedValueOnce({ ok: true, text: TEXT, spans: [{ page: 1, start: 0, end: TEXT.length }], pageCount: 1, extractor: "fixture@1" });
  const r = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!r.ok) throw new Error("seed failed");
  return doc;
}

async function acceptOne(auth: { workspaceId: string; userId: string; role: "owner" }, docId: string) {
  const [proposal] = await proposeZettels(auth, {
    documentId: docId,
    extractor: extractor([{ title: "Monthly rent", claim: "Rent is $1,200 a month.", quote: Q1 }]),
  });
  return { proposal, result: await acceptZettel(auth, { proposalId: proposal.id }) };
}

suite("zettel cards (real Postgres)", () => {
  it("accept creates a zettel artifact with a versioned card body", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { proposal, result } = await acceptOne(auth, doc.id);

    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(card.kind).toBe("zettel");
    expect(card.title).toBe("Monthly rent");
    expect(card.workspaceId).toBe(auth.workspaceId);

    const [version] = await holder.db!.select().from(artifactVersions).where(eq(artifactVersions.id, card.currentVersionId!));
    expect(version.plainText).toContain("Rent is $1,200 a month.");
    expect(version.plainText).toContain(Q1);

    // The proposal records the card it became, alongside the claim evidence.
    const [row] = await holder.db!.select().from(zettelProposals).where(eq(zettelProposals.id, proposal.id));
    expect(row.artifactId).toBe(card.id);
    expect(row.conceptId).not.toBeNull();
    expect(row.claimId).not.toBeNull();
    const ev = await holder.db!.select().from(claimEvidence).where(eq(claimEvidence.claimId, row.claimId!));
    expect(ev).toHaveLength(1);
  });

  it("the card points at its source document with a typed, contextual edge", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { result } = await acceptOne(auth, doc.id);

    const [edge] = await holder.db!.select().from(artifactLinks).where(and(
      eq(artifactLinks.artifactId, result.artifactId),
      eq(artifactLinks.linkType, "source"),
    ));
    expect(edge.targetType).toBe("document");
    expect(edge.targetId).toBe(doc.id);
    expect(edge.context).toBe(Q1);

    const sourcesList = await listNoteSources(auth, result.artifactId);
    expect(sourcesList).toHaveLength(1);
    expect(sourcesList[0].title).toBe("lease");
  });

  it("a note can wiki-link to a zettel and the backlink reads both ways", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { result } = await acceptOne(auth, doc.id);

    const note = await createNote(auth, { title: "Lease thoughts", content: { type: "doc", content: [] } });
    const text = "The [[Monthly rent]] point matters for cash flow.";
    await autosaveNoteDraft(auth, {
      artifactId: note.id,
      expectedVersion: note.version,
      content: { type: "doc", content: [] },
      plainText: text,
    });

    const outlinks = await listNoteOutlinks(auth, note.id);
    expect(outlinks).toHaveLength(1);
    expect(outlinks[0].id).toBe(result.artifactId);
    expect(outlinks[0].kind).toBe("zettel");
    expect(outlinks[0].linkType).toBe("reference");
    expect(outlinks[0].excerpt).toContain("Rent is $1,200");

    const backlinks = await listNoteBacklinks(auth, result.artifactId);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].id).toBe(note.id);
    expect(backlinks[0].kind).toBe("note");
  });

  it("a zettel wiki-links to a note, and removing the title removes only that edge", async () => {
    const auth = await workspace();
    const note = await createNote(auth, { title: "Cash flow", content: { type: "doc", content: [] } });
    const zettel = await createNote(auth, { title: "Deposit handling", kind: "zettel", content: { type: "doc", content: [] } });

    await autosaveNoteDraft(auth, {
      artifactId: zettel.id,
      expectedVersion: zettel.version,
      content: { type: "doc", content: [] },
      plainText: "Feeds [[Cash flow]].",
    });
    let backlinks = await listNoteBacklinks(auth, note.id);
    expect(backlinks.map((b) => b.id)).toEqual([zettel.id]);

    const after = await holder.db!.select().from(artifacts).where(eq(artifacts.id, zettel.id));
    await autosaveNoteDraft(auth, {
      artifactId: zettel.id,
      expectedVersion: after[0].version,
      content: { type: "doc", content: [] },
      plainText: "No links left.",
    });
    backlinks = await listNoteBacklinks(auth, note.id);
    expect(backlinks).toHaveLength(0);
  });

  it("reject writes no card", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const [p1] = await proposeZettels(auth, {
      documentId: doc.id,
      extractor: extractor([{ title: "Deposit", claim: "The landlord holds the deposit.", quote: Q2 }]),
    });
    const { rejectZettel } = await import("@/domains/knowledge/zettels");
    await rejectZettel(auth, { proposalId: p1.id });
    const cards = await holder.db!.select().from(artifacts).where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(0);
  });
});
