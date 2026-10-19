import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { documentPlacements, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Folders and tags: organisation only. Moves and tags are idempotent, scoped
 * to the workspace, audited once per real change, and never touch the
 * document row itself.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let folders: typeof import("@/domains/knowledge/folders");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  folders = await import("@/domains/knowledge/folders");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string, docs = 2) {
  const seeded = await seedWorkspace(db, `${slug}-${Date.now()}`);
  const auth = ownerAuth(seeded.userId, seeded.workspaceId);
  const rows = await db
    .insert(documents)
    .values(Array.from({ length: docs }, (_, i) => ({ workspaceId: auth.workspaceId, title: `${slug}-${i}.pdf` })))
    .returning();
  return { auth, docs: rows };
}

suite("document folders and tags", () => {
  it("creates folders with a unique, case-insensitive name per workspace", async () => {
    const { auth } = await seed("folder-unique");
    await folders.createFolder(auth, { name: "Tax" });
    await expect(folders.createFolder(auth, { name: " tax " })).rejects.toMatchObject({ code: "duplicate" });
    expect((await folders.listFolders(auth)).map((f) => f.name)).toEqual(["Tax"]);
  });

  it("moves documents idempotently and audits only real changes", async () => {
    const { auth, docs } = await seed("folder-move");
    const folder = await folders.createFolder(auth, { name: "Leases" });
    const ids = docs.map((d) => d.id);
    expect(await folders.moveDocuments(auth, { documentIds: ids, folderId: folder.id })).toEqual({ moved: 2 });
    expect(await folders.moveDocuments(auth, { documentIds: ids, folderId: folder.id })).toEqual({ moved: 0 });
    const events = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "document.moved")));
    expect(events).toHaveLength(2);
    expect((await folders.listFolders(auth))[0]!.documentCount).toBe(2);
    expect(await folders.moveDocuments(auth, { documentIds: [ids[0]!], folderId: null })).toEqual({ moved: 1 });
    expect((await folders.listFolders(auth))[0]!.documentCount).toBe(1);
  });

  it("refuses a document or folder from another workspace", async () => {
    const mine = await seed("folder-mine", 1);
    const theirs = await seed("folder-theirs", 1);
    const theirFolder = await folders.createFolder(theirs.auth, { name: "Theirs" });
    await expect(
      folders.moveDocuments(mine.auth, { documentIds: [theirs.docs[0]!.id], folderId: null }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      folders.moveDocuments(mine.auth, { documentIds: [mine.docs[0]!.id], folderId: theirFolder.id }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("archiving a folder keeps its documents and clears their placement", async () => {
    const { auth, docs } = await seed("folder-archive", 1);
    const folder = await folders.createFolder(auth, { name: "Old" });
    await folders.moveDocuments(auth, { documentIds: [docs[0]!.id], folderId: folder.id });
    await folders.archiveFolder(auth, { folderId: folder.id, expectedVersion: folder.version });
    expect(await folders.listFolders(auth)).toEqual([]);
    const placements = await db.select().from(documentPlacements).where(eq(documentPlacements.documentId, docs[0]!.id));
    expect(placements).toHaveLength(0);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docs[0]!.id));
    expect(doc?.archivedAt).toBeNull();
    await expect(folders.archiveFolder(auth, { folderId: folder.id, expectedVersion: folder.version })).rejects.toMatchObject({ code: "stale" });
  });

  it("rename is version-guarded", async () => {
    const { auth } = await seed("folder-rename", 1);
    const folder = await folders.createFolder(auth, { name: "A" });
    const renamed = await folders.renameFolder(auth, { folderId: folder.id, name: "B", expectedVersion: folder.version });
    expect(renamed.name).toBe("B");
    await expect(folders.renameFolder(auth, { folderId: folder.id, name: "C", expectedVersion: folder.version })).rejects.toMatchObject({ code: "stale" });
  });

  it("tags add and remove idempotently", async () => {
    const { auth, docs } = await seed("folder-tags");
    const ids = docs.map((d) => d.id);
    expect(await folders.addTag(auth, { documentIds: ids, tag: "#Tax" })).toEqual({ added: 2 });
    expect(await folders.addTag(auth, { documentIds: ids, tag: "tax" })).toEqual({ added: 0 });
    const org = await folders.getOrganisation(auth, ids);
    expect(org.tagsByDocument.get(ids[0]!)).toEqual(["tax"]);
    expect(await folders.removeTag(auth, { documentIds: [ids[0]!], tag: "tax" })).toEqual({ removed: 1 });
    expect(await folders.removeTag(auth, { documentIds: [ids[0]!], tag: "tax" })).toEqual({ removed: 0 });
  });
});
