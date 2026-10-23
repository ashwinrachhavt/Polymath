import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { companies, contacts } from "@/domains/crm/schema";
import { artifactLinks, artifacts, artifactVersions, documents } from "@/domains/knowledge/schema";
import { opportunities } from "@/domains/opportunities/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { editGeneratedDraft, getDraftDetail, saveDraft } from "@/domains/knowledge/studio";
import { linkDraftToRecord, resolveLinkTitles, unlinkDraftFromRecord } from "@/app/(workspace)/alfred/dossiers/links";

suite("draft workbench (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let artifactId: string;
  let documentId: string;
  let taskId: string;
let companyId: string;
  let contactId: string;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `workbench-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);

    const [artifact] = await handle.db
      .insert(artifacts)
      .values({ workspaceId: seed.workspaceId, kind: "report", title: "Market brief", status: "draft", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    artifactId = artifact.id;
    const [version] = await handle.db
      .insert(artifactVersions)
      .values({ workspaceId: seed.workspaceId, artifactId, versionNumber: 1, content: { text: "First pass." }, plainText: "First pass.", reason: "generated", createdBy: seed.userId })
      .returning();
    await handle.db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifactId));

    const [doc] = await handle.db
      .insert(documents)
      .values({ workspaceId: seed.workspaceId, title: "Source paper", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    documentId = doc.id;
    await handle.db
      .insert(artifactLinks)
      .values({ workspaceId: seed.workspaceId, artifactId, targetType: "document", targetId: documentId, label: "pinned:deadbeef1234" });

    const [task] = await handle.db
      .insert(tasks)
      .values({ workspaceId: seed.workspaceId, title: "Follow up on the brief", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    taskId = task.id;
    const [contact] = await handle.db
      .insert(contacts)
      .values({ workspaceId: seed.workspaceId, fullName: "Ravi Example", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    contactId = contact.id;
    await handle.db
      .insert(opportunities)
      .values({ workspaceId: seed.workspaceId, title: "Acme expansion", createdBy: seed.userId, updatedBy: seed.userId });
    const [company] = await handle.db
      .insert(companies)
      .values({ workspaceId: seed.workspaceId, name: "Acme Corp", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    companyId = company.id;
  });

  it("getDraftDetail returns the text, the pinned source, and record links", async () => {
    if (!handle) return;
    await linkDraftToRecord(auth, { artifactId, targetType: "task", targetId: taskId });
    await linkDraftToRecord(auth, { artifactId, targetType: "company", targetId: companyId });
    const detail = (await getDraftDetail(auth, artifactId))!;
    expect(detail.artifact.title).toBe("Market brief");
    expect(detail.text).toBe("First pass.");
    expect(detail.sources).toEqual([{ documentId, title: "Source paper", pinnedHash: "deadbeef1234" }]);
    expect(detail.links).toHaveLength(2);
    const titles = await resolveLinkTitles(auth, detail.links);
    const byType = Object.fromEntries(detail.links.map((l) => [l.targetType, l.id]));
    expect(titles[byType.task]).toBe("Follow up on the brief");
    expect(titles[byType.company]).toBe("Acme Corp");
  });

  it("linkDraftToRecord rejects a record outside the workspace, and unlink removes the row", async () => {
    if (!handle) return;
    await expect(linkDraftToRecord(auth, { artifactId, targetType: "contact", targetId: crypto.randomUUID() })).rejects.toThrow("That record was not found.");
    await linkDraftToRecord(auth, { artifactId, targetType: "contact", targetId: contactId });
    // Linking the same pair twice keeps one row.
    await linkDraftToRecord(auth, { artifactId, targetType: "contact", targetId: contactId });
    let detail = (await getDraftDetail(auth, artifactId))!;
    const contactLinks = detail.links.filter((l) => l.targetType === "contact");
    expect(contactLinks).toHaveLength(1);
    await unlinkDraftFromRecord(auth, { artifactId, linkId: contactLinks[0].id });
    detail = (await getDraftDetail(auth, artifactId))!;
    expect(detail.links.filter((l) => l.targetType === "contact")).toHaveLength(0);
  });

  it("editGeneratedDraft appends a version under the expectedVersion guard", async () => {
    if (!handle) return;
    const before = (await getDraftDetail(auth, artifactId))!;
    const key = crypto.randomUUID();
    const input = { artifactId, expectedVersion: before.artifact.version, text: "Second pass, edited by hand.", idempotencyKey: key };
    const result = await editGeneratedDraft(auth, input);
    expect(result.version).toBe(before.artifact.version + 1);
    const after = (await getDraftDetail(auth, artifactId))!;
    expect(after.text).toBe("Second pass, edited by hand.");
    // The same idempotency key replays the result instead of appending again.
    const replay = await editGeneratedDraft(auth, input);
    expect(replay.version).toBe(result.version);
    // A stale expectedVersion loses.
    await expect(
      editGeneratedDraft(auth, { artifactId, expectedVersion: before.artifact.version, text: "Conflicting edit.", idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow("changed elsewhere");
  });

  it("an archived draft is no longer editable", async () => {
    if (!handle) return;
    const detail = (await getDraftDetail(auth, artifactId))!;
    await saveDraft(auth, { artifactId });
    // Reviewed stays editable…
    const edited = await editGeneratedDraft(auth, { artifactId, expectedVersion: detail.artifact.version + 1, text: "Post-review polish.", idempotencyKey: crypto.randomUUID() });
    expect(edited.version).toBe(detail.artifact.version + 2);
    // …but an archived one is not.
    const [row] = await handle.db.update(artifacts).set({ status: "archived", archivedAt: new Date() }).where(eq(artifacts.id, artifactId)).returning();
    expect(row.status).toBe("archived");
    await expect(
      editGeneratedDraft(auth, { artifactId, expectedVersion: edited.version, text: "Too late.", idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow("changed elsewhere");
  });

  it("getDraftDetail returns the append-only version history, newest first", async () => {
    if (!handle) return;
    const [artifact] = await handle.db
      .insert(artifacts)
      .values({ workspaceId: auth.workspaceId, kind: "report", title: "History probe", status: "draft", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    const [v1] = await handle.db
      .insert(artifactVersions)
      .values({ workspaceId: auth.workspaceId, artifactId: artifact.id, versionNumber: 1, content: { text: "v1" }, plainText: "v1", reason: "generated", createdBy: auth.userId })
      .returning();
    await handle.db.update(artifacts).set({ currentVersionId: v1.id }).where(eq(artifacts.id, artifact.id));

    let detail = (await getDraftDetail(auth, artifact.id))!;
    expect(detail.versions.map((v) => v.versionNumber)).toEqual([1]);
    expect(detail.versions[0].reason).toBe("generated");

    await editGeneratedDraft(auth, { artifactId: artifact.id, expectedVersion: 1, text: "v2, hand edited.", idempotencyKey: crypto.randomUUID() });
    detail = (await getDraftDetail(auth, artifact.id))!;
    // Newest first, and the earlier version is still there: edits append, never overwrite.
    expect(detail.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(detail.versions[0].reason).toBe("edited");
    expect(detail.versions.every((v) => v.createdAt instanceof Date)).toBe(true);
  });
});
