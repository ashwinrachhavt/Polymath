import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { files } from "@/domains/knowledge/schema";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Assessment item D: the provenance chain reads back - accepted obligation,
 * its document, the passage, the audit trail - for the task panel.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let obligations: typeof import("@/domains/knowledge/obligations");
let knowledge: typeof import("@/domains/knowledge/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  obligations = await import("@/domains/knowledge/obligations");
  knowledge = await import("@/domains/knowledge/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("task provenance", () => {
  it("an accepted obligation's chain reads back for its task", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `prov-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const [blob] = await db.insert(blobObjects).values({
      workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
      sizeBytes: 4, mimeType: "application/pdf",
    }).returning();
    const [file] = await db.insert(files).values({ workspaceId, blobId: blob.id, filename: "lease.pdf" }).returning();
    const [doc] = await db.insert(documents).values({
      workspaceId, title: "Harbor Lane lease", fileId: file.id, mimeType: "application/pdf",
    }).returning();
    const [extraction] = await db.insert(documentExtractions).values({
      workspaceId, documentId: doc.id, contentHash: blob.contentHash, status: "succeeded",
      text: "Renew by November 1.", spans: [{ page: 1, start: 0, end: 20 }], extractor: "fixture@1", proposalStatus: "succeeded",
    }).returning();

    const proposed = await obligations.proposeObligation(auth, {
      documentId: doc.id,
      kind: "renewal",
      note: "Renew the Harbor Lane lease",
      dedupeKey: `renewal-${doc.id}`,
    });
    const { taskId } = await obligations.acceptObligation(auth, { obligationId: proposed.id });

    const provenance = await knowledge.getTaskProvenance(auth, taskId);
    expect(provenance).toHaveLength(1);
    expect(provenance[0].documentTitle).toBe("Harbor Lane lease");
    expect(provenance[0].note).toBe("Renew the Harbor Lane lease");
    expect(provenance[0].status).toBe("accepted");
    expect(provenance[0].decidedAt).toBeTruthy();
    expect(provenance[0].history.length).toBeGreaterThan(0);

    // A task with no obligation reads back empty, not an error.
    expect(await knowledge.getTaskProvenance(auth, crypto.randomUUID())).toHaveLength(0);
    void extraction;
  });
});
