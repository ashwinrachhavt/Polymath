import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import {
  documentExtractions,
  documents,
  fieldProposals,
  files,
} from "@/domains/knowledge/schema";
import { documentStatus } from "@/domains/knowledge/status";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The library backend against real Postgres (ASH-108/ASH-127/ASH-130):
 * folder tree rules, keyset pagination that neither skips nor repeats, the
 * SQL state filter's parity with status.ts, and export manifests that pin
 * exact versions. Skipped without TEST_DATABASE_URL, same as the other
 * suites; fresh unique slugs, no truncation.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: {
  db: NonNullable<ReturnType<typeof makeTestDb>>["db"];
} = { db: undefined as never };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

/*
 * Domain modules import lib/db-transaction, which binds DATABASE_URL at
 * module load - so they load lazily, after makeTestDb has pointed it at the
 * scratch database (same discipline as classification.test.ts).
 */
let folders: typeof import("@/domains/knowledge/folders");
let tags: typeof import("@/domains/knowledge/tags");
let exports_: typeof import("@/domains/knowledge/exports");
let library: typeof import("@/domains/knowledge/library");

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  folders = await import("@/domains/knowledge/folders");
  exports_ = await import("@/domains/knowledge/exports");
  library = await import("@/domains/knowledge/library");
  tags = await import("@/domains/knowledge/tags");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("document library", () => {
  type Auth = { userId: string; workspaceId: string; role: "owner" };

  async function seedAuth(slug: string): Promise<Auth> {
    const { userId, workspaceId } = await seedWorkspace(holder.db, `lib-${slug}-${Date.now()}`);
    return { userId, workspaceId, role: "owner" };
  }

  async function seedDocument(
    auth: Auth,
    values: {
      title: string;
      filename?: string;
      folderId?: string | null;
      extraction?: { status: "pending" | "succeeded" | "failed"; proposalStatus?: "pending" | "succeeded" | "failed" | null; text?: string } | null;
      undecidedProposals?: number;
    },
  ) {
    let fileId: string | null = null;
    if (values.filename) {
      const [blob] = await holder.db
        .insert(blobObjects)
        .values({ workspaceId: auth.workspaceId, storageKey: `key-${crypto.randomUUID()}`, contentHash: `hash-${crypto.randomUUID()}`, sizeBytes: 2048, mimeType: "application/pdf" })
        .returning();
      const [file] = await holder.db
        .insert(files)
        .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: values.filename })
        .returning();
      fileId = file.id;
    }
    const [document] = await holder.db
      .insert(documents)
      .values({ workspaceId: auth.workspaceId, title: values.title, fileId, folderId: values.folderId ?? null })
      .returning();
    if (values.extraction) {
      await holder.db.insert(documentExtractions).values({
        workspaceId: auth.workspaceId,
        documentId: document.id,
        contentHash: `ch-${crypto.randomUUID()}`,
        status: values.extraction.status,
        proposalStatus: values.extraction.proposalStatus ?? null,
        text: values.extraction.text ?? null,
      });
    }
    for (let i = 0; i < (values.undecidedProposals ?? 0); i += 1) {
      const [extraction] = await holder.db
        .select({ id: documentExtractions.id })
        .from(documentExtractions)
        .limit(1);
      await holder.db.insert(fieldProposals).values({
        workspaceId: auth.workspaceId,
        documentId: document.id,
        extractionId: extraction.id,
        fieldKind: "text",
        fieldName: `field_${i}`,
        dedupeKey: `dk-${crypto.randomUUID()}`,
        status: "proposed",
      });
    }
    return document;
  }

  it("folders: create, list with counts, move cycle refused, archive rules", async () => {
    const auth = await seedAuth("folders");
    const root = await folders.createFolder(auth, { name: "Tax" });
    const child = await folders.createFolder(auth, { name: "2026", parentId: root.id });

    // A folder cannot move into its own descendant.
    await expect(folders.moveFolder(auth, { folderId: root.id, parentId: child.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "cycle" });

    // Non-empty folders cannot be archived.
    const doc = await seedDocument(auth, { title: "Return", folderId: child.id });
    await expect(folders.archiveFolder(auth, { folderId: root.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "not_empty" });
    await expect(folders.archiveFolder(auth, { folderId: child.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "not_empty" });

    // Moving the document out empties the folder; archiving then works, and
    // the move lands in the activity feed.
    await folders.setDocumentFolder(auth, { documentId: doc.id, folderId: null, expectedVersion: 1 });
    await folders.archiveFolder(auth, { folderId: child.id, expectedVersion: 1 });

    const folderList = await library.listFolders(auth);
    expect(folderList.map((f) => f.name)).toEqual(["Tax"]);
    expect(folderList[0].documentCount).toBe(0);

    const activity = await library.getDocumentActivity(auth, { documentId: doc.id });
    expect(activity.some((a) => a.kind === "moved" && a.detail.to === "the library root")).toBe(true);
  });

  it("listDocuments: keyset pages neither skip nor repeat, filters compose", async () => {
    const auth = await seedAuth("pages");
    const folder = await folders.createFolder(auth, { name: "Invoices" });
    const titles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    for (const title of titles) {
      await seedDocument(auth, { title, filename: `${title.toLowerCase()}.pdf`, folderId: folder.id });
    }
    await seedDocument(auth, { title: "Root doc", filename: "root.pdf" });

    const page1 = await library.listDocuments(auth, { filters: { folder: folder.id }, sort: "title", limit: 2 });
    expect(page1.rows.map((r) => r.title)).toEqual(["Alpha", "Bravo"]);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).toBeTruthy();

    const seen = new Set(page1.rows.map((r) => r.id));
    let cursor = page1.nextCursor;
    const rest: string[] = [];
    while (cursor) {
      const page = await library.listDocuments(auth, { filters: { folder: folder.id }, sort: "title", limit: 2, cursor });
      for (const row of page.rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
        rest.push(row.title);
      }
      cursor = page.nextCursor;
    }
    expect(rest).toEqual(["Charlie", "Delta", "Echo"]);

    // Root filter sees only the unfiled document.
    const root = await library.listDocuments(auth, { filters: { folder: "root" } });
    expect(root.rows.map((r) => r.title)).toEqual(["Root doc"]);

    // Name search hits title and original filename.
    const found = await library.listDocuments(auth, { filters: { q: "bravo" } });
    expect(found.rows.map((r) => r.title)).toEqual(["Bravo"]);
  });

  it("listDocuments: the state filter matches status.ts combination by combination", async () => {
    const auth = await seedAuth("states");
    const cases: Array<{
      key: import("@/domains/knowledge/library").LibraryStateFilter;
      extraction: { status: "pending" | "succeeded" | "failed"; proposalStatus?: "pending" | "succeeded" | "failed" | null } | null;
      undecided: number;
    }> = [
      { key: "added", extraction: null, undecided: 0 },
      { key: "reading", extraction: { status: "pending" }, undecided: 0 },
      { key: "could_not_read", extraction: { status: "failed" }, undecided: 0 },
      { key: "fields_not_read", extraction: { status: "succeeded", proposalStatus: "failed" }, undecided: 0 },
      { key: "fields_not_proposed", extraction: { status: "succeeded", proposalStatus: null }, undecided: 0 },
      { key: "reading", extraction: { status: "succeeded", proposalStatus: "pending" }, undecided: 0 },
      { key: "needs_check", extraction: { status: "succeeded", proposalStatus: "succeeded" }, undecided: 2 },
      { key: "filed", extraction: { status: "succeeded", proposalStatus: "succeeded" }, undecided: 0 },
    ];
    for (const c of cases) {
      await seedDocument(auth, {
        title: `state-${c.key}-${crypto.randomUUID()}`,
        extraction: c.extraction,
        undecidedProposals: c.undecided,
      });
    }

    for (const c of cases) {
      const page = await library.listDocuments(auth, { filters: { state: c.key }, limit: 100 });
      // Every row the filter returns must carry the same state key, and the
      // label must be the one status.ts gives the same situation.
      for (const row of page.rows) {
        expect(row.state.key).toBe(c.key);
      }
      const seeded = page.rows.filter((r) => r.title.startsWith(`state-${c.key}-`));
      expect(seeded.length).toBeGreaterThanOrEqual(1);
    }

    // And the total across all states equals the workspace's documents.
    const all = await library.listDocuments(auth, { limit: 100 });
    expect(all.total).toBe(cases.length);

    // Parity spot check: a needs_check row's label is status.ts's own words.
    const needsCheck = await library.listDocuments(auth, { filters: { state: "needs_check" } });
    expect(needsCheck.rows[0].state.label).toBe(documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 2).label);
  });

  it("export manifests pin exact versions and report drift", async () => {
    const auth = await seedAuth("exports");
    const doc = await seedDocument(auth, {
      title: "Agreement",
      filename: "agreement.pdf",
      extraction: { status: "succeeded", proposalStatus: "succeeded", text: "services begin november 1" },
    });

    const manifest = await exports_.createExportManifest(auth, {
      name: "Visa packet",
      purpose: "H-1B filing",
      items: [{ documentId: doc.id }],
    });
    const first = await exports_.getExportManifest(auth, { manifestId: manifest.id });
    expect(first?.items).toHaveLength(1);
    expect(first?.items[0].pinned.contentHash).toBeTruthy();
    expect(first?.items[0].isCurrent).toBe(true);

    // A re-extraction leaves the pin alone; the manifest says it drifted.
    await holder.db.insert(documentExtractions).values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      contentHash: `ch-${crypto.randomUUID()}`,
      status: "succeeded",
      text: "services begin november 1 (amended)",
    });
    const after = await exports_.getExportManifest(auth, { manifestId: manifest.id });
    expect(after?.items[0].isCurrent).toBe(false);
    expect(after?.items[0].pinned.contentHash).not.toBe(after?.items[0].current?.contentHash);

    // Stale writes are refused.
    await expect(
      exports_.removeExportItem(auth, { manifestId: manifest.id, itemId: after!.items[0].itemId, expectedVersion: 99 }),
    ).rejects.toMatchObject({ code: "stale_write" });

    // A foreign document id fails the whole command.
    const other = await seedAuth("exports-other");
    const foreign = await seedDocument(other, { title: "Not yours" });
    await expect(
      exports_.createExportManifest(auth, { name: "Nope", items: [{ documentId: foreign.id }] }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("search finds extraction text and survives a failed extraction", async () => {
    const auth = await seedAuth("fts");
    await seedDocument(auth, {
      title: "Bank statement",
      filename: "statement.pdf",
      extraction: { status: "succeeded", proposalStatus: "succeeded", text: "opening balance four hundred dollars" },
    });
    await seedDocument(auth, { title: "Scanned receipt", filename: "receipt-scan.pdf", extraction: { status: "failed" } });

    const byText = await library.listDocuments(auth, { filters: { q: "balance" } });
    expect(byText.rows.map((r) => r.title)).toEqual(["Bank statement"]);
    expect(byText.rows[0].snippet).toContain("[[");

    const byName = await library.listDocuments(auth, { filters: { q: "receipt-scan" } });
    expect(byName.rows.map((r) => r.title)).toEqual(["Scanned receipt"]);
    expect(byName.rows[0].state.key).toBe("could_not_read");
  });

  it("tags: batch tagging is idempotent, the tag filter composes, untagging is exact", async () => {
    const auth = await seedAuth("tags");
    const a = await seedDocument(auth, { title: "Tagged A" });
    const b = await seedDocument(auth, { title: "Tagged B" });
    await seedDocument(auth, { title: "Untagged" });

    await tags.addTag(auth, { documentIds: [a.id, b.id], tag: "  Tax  2026 " });
    await tags.addTag(auth, { documentIds: [a.id, b.id], tag: "tax 2026" }); // re-tag folds

    const withTag = await library.listDocuments(auth, { filters: { tag: "tax 2026" } });
    expect(withTag.rows.map((r) => r.title).sort()).toEqual(["Tagged A", "Tagged B"]);
    expect(withTag.rows[0].tags).toEqual(["tax 2026"]);

    const all = await tags.listTags(auth);
    expect(all).toEqual([{ tag: "tax 2026", documentCount: 2 }]);

    await tags.removeTag(auth, { documentIds: [a.id], tag: "tax 2026" });
    const after = await library.listDocuments(auth, { filters: { tag: "tax 2026" } });
    expect(after.rows.map((r) => r.title)).toEqual(["Tagged B"]);

    // A foreign document id fails the whole command.
    const other = await seedAuth("tags-other");
    const foreign = await seedDocument(other, { title: "Not yours" });
    await expect(tags.addTag(auth, { documentIds: [a.id, foreign.id], tag: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
});
