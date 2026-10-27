import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactLinks, artifacts, claimEvidence, claims, documentReadingState, documents, sources } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedTask, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for the knowledge-debt report (ASH-295): each
 * signal names the right rows (zero-link notes, unsupported claims,
 * descriptionless open tasks, never-opened documents), exclusions hold
 * (archived notes, rejected claims, done tasks, opened documents), links
 * count in either direction, and tenancy isolates the report.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let debt: typeof import("@/domains/knowledge/debt");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  debt = await import("@/domains/knowledge/debt");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("knowledge debt", () => {
  it("names the right rows, honors exclusions, and isolates tenants", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `debt-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const other = await seedWorkspace(db, `debt-other-${Date.now()}`);

    // Notes: one orphan (no links either way), one linked, one archived orphan.
    const [orphan] = await db.insert(artifacts).values({ workspaceId, kind: "note", title: "Orphan note", status: "draft" }).returning({ id: artifacts.id });
    const [linkedA] = await db.insert(artifacts).values({ workspaceId, kind: "note", title: "Linked note A", status: "published" }).returning({ id: artifacts.id });
    const [linkedB] = await db.insert(artifacts).values({ workspaceId, kind: "zettel", title: "Linked zettel B", status: "reviewed" }).returning({ id: artifacts.id });
    await db.insert(artifacts).values({ workspaceId, kind: "note", title: "Archived orphan", status: "archived" });
    await db.insert(artifactLinks).values({ workspaceId, artifactId: linkedA.id, targetType: "zettel", targetId: linkedB.id, linkType: "reference" });
    // A row in the OTHER workspace that would pollute every signal if tenancy leaked.
    await db.insert(artifacts).values({ workspaceId: other.workspaceId, kind: "note", title: "Someone else's orphan", status: "draft" });

    // Claims: one unsupported proposed, one supported accepted, one rejected without evidence.
    const [unsupported] = await db.insert(claims).values({ workspaceId, statement: "The sky is green.", status: "proposed" }).returning({ id: claims.id });
    const [supported] = await db.insert(claims).values({ workspaceId, statement: "Water is wet.", status: "accepted" }).returning({ id: claims.id });
    await db.insert(claims).values({ workspaceId, statement: "A rejected guess.", status: "rejected" });
    const [source] = await db.insert(sources).values({ workspaceId, kind: "web", url: `https://example.com/${Date.now()}`, title: "Evidence" }).returning({ id: sources.id });
    await db.insert(claimEvidence).values({ workspaceId, claimId: supported.id, sourceId: source.id, quote: "Water is wet." });
    await db.insert(claims).values({ workspaceId: other.workspaceId, statement: "Not your claim.", status: "proposed" });

    // Tasks: one open with no description, one open described, one done without.
    await seedTask(db, workspaceId, { title: "Do the unexplained thing", status: "ready" });
    await seedTask(db, workspaceId, { title: "Described work", status: "ready", description: "Because reasons." });
    await seedTask(db, workspaceId, { title: "Finished work", status: "done" });

    // Documents: one never opened, one opened.
    const [unreadDoc] = await db.insert(documents).values({ workspaceId, title: "Captured, never read" }).returning({ id: documents.id });
    const [readDoc] = await db.insert(documents).values({ workspaceId, title: "Actually read" }).returning({ id: documents.id });
    await db.insert(documentReadingState).values({ workspaceId, documentId: readDoc.id, userId });
    await db.insert(documents).values({ workspaceId: other.workspaceId, title: "Someone else's unread" });

    const report = await debt.getKnowledgeDebt(auth);

    expect(report.zeroLinkNotes.items.map((i) => i.id)).toEqual([orphan.id]);
    expect(report.unsupportedClaims.items.map((i) => i.id)).toEqual([unsupported.id]);
    expect(report.tasksWithoutRationale.items.map((i) => i.title)).toEqual(["Do the unexplained thing"]);
    expect(report.neverOpenedDocuments.items.map((i) => i.id)).toEqual([unreadDoc.id]);
    for (const section of Object.values(report)) {
      expect(section.total).toBe(1);
    }
  });
});
