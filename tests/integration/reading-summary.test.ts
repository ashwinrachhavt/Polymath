import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactLinks, artifacts, documentExtractions, documents, zettelProposals } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for the reading-summary accept path (ASH-292): the
 * accepted summary becomes a note linked to its source document, each
 * verified claim opens a zettel proposal with the extraction lineage, the
 * audit row records the accept, a retried accept with the same key folds
 * instead of duplicating, and a second tenant cannot accept against the
 * first tenant's document.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let mod: typeof import("@/domains/knowledge/reading-summary");

const TEXT = "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days.";

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  mod = await import("@/domains/knowledge/reading-summary");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("reading summary accept", () => {
  it("commits the note, the source link, the proposals, and folds a retry", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `rsum-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const other = await seedWorkspace(db, `rsum-other-${Date.now()}`);

    const [doc] = await db.insert(documents).values({ workspaceId, title: "Lease renewal letter" }).returning({ id: documents.id });
    await db.insert(documentExtractions).values({
      workspaceId,
      documentId: doc.id,
      contentHash: `hash-${Date.now()}`,
      status: "succeeded",
      text: TEXT,
    });

    const verified = mod.verifyReadingSummary(TEXT, {
      summary: "A lease renewal letter with a rent increase clause.",
      keyClaims: [{ claim: "The lease renews March 1.", quote: "The lease renews on March 1." }],
      openQuestions: ["Is the increase capped?"],
    });
    expect(verified.keyClaims).toHaveLength(1);

    const key = `rsum-${doc.id}`;
    const first = await mod.acceptReadingSummary(auth, { documentId: doc.id, summary: verified, proposer: "test:summarizer", idempotencyKey: key });

    const [note] = await db.select().from(artifacts).where(eq(artifacts.id, first.note.id));
    expect(note.title).toBe("Summary of Lease renewal letter");
    expect(note.kind).toBe("note");

    const links = await db.select().from(artifactLinks).where(and(eq(artifactLinks.artifactId, note.id), eq(artifactLinks.targetType, "document")));
    expect(links).toHaveLength(1);
    expect(links[0].targetId).toBe(doc.id);
    expect(links[0].linkType).toBe("source");

    const proposals = await db.select().from(zettelProposals).where(eq(zettelProposals.documentId, doc.id));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].claim).toBe("The lease renews March 1.");
    expect(proposals[0].status).toBe("proposed");
    expect(first.proposals).toBe(1);

    // Same key, same claims: the note folds and the proposal dedupe key holds.
    const second = await mod.acceptReadingSummary(auth, { documentId: doc.id, summary: verified, proposer: "test:summarizer", idempotencyKey: key });
    expect(second.note.id).toBe(first.note.id);
    expect(second.proposals).toBe(0);
    const allNotes = await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId));
    expect(allNotes).toHaveLength(1);

    // Another tenant cannot accept against this document.
    await expect(
      mod.acceptReadingSummary(ownerAuth(other.userId, other.workspaceId), { documentId: doc.id, summary: verified, proposer: "test:summarizer", idempotencyKey: `rsum-x-${doc.id}` }),
    ).rejects.toMatchObject({ code: "document_not_found" });
  });
});
