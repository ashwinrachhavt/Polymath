import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentReadingEvents, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * D18 invariants: a reading event and its folded state commit together, a
 * retried client_event_id folds exactly once, and one workspace's reading
 * never appears in another's.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let reading: typeof import("@/domains/knowledge/reading");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  reading = await import("@/domains/knowledge/reading");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const seeded = await seedWorkspace(db, `${slug}-${Date.now()}`);
  const auth = ownerAuth(seeded.userId, seeded.workspaceId);
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: `${slug}.pdf` })
    .returning();
  return { auth, doc };
}

suite("reading engagement", () => {
  it("opened then progress folds into one state row", async () => {
    const { auth, doc } = await seed("reading-fold");
    const visitId = crypto.randomUUID();
    await reading.recordReadingEvent(auth, { documentId: doc.id, visitId, kind: "opened" });
    await reading.recordReadingEvent(auth, {
      documentId: doc.id,
      visitId,
      kind: "progress",
      progress: 0.45,
      activeSeconds: 90,
    });
    await reading.recordReadingEvent(auth, {
      documentId: doc.id,
      visitId,
      kind: "progress",
      progress: 0.2,
      activeSeconds: 30,
    });

    const readable = await reading.getReadableDocument(auth, doc.id);
    expect(readable?.state).toMatchObject({ openCount: 1, totalActiveSeconds: 120, furthestProgress: 0.45 });

    const events = await db
      .select()
      .from(documentReadingEvents)
      .where(and(eq(documentReadingEvents.documentId, doc.id)));
    expect(events).toHaveLength(3);
  });

  it("a retried client_event_id folds exactly once", async () => {
    const { auth, doc } = await seed("reading-retry");
    const visitId = crypto.randomUUID();
    const clientEventId = crypto.randomUUID();
    const input = {
      documentId: doc.id,
      visitId,
      kind: "progress" as const,
      progress: 0.5,
      activeSeconds: 60,
      clientEventId,
    };
    const first = await reading.recordReadingEvent(auth, input);
    const second = await reading.recordReadingEvent(auth, input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);

    const readable = await reading.getReadableDocument(auth, doc.id);
    expect(readable?.state).toMatchObject({ totalActiveSeconds: 60, furthestProgress: 0.5 });

    const events = await db
      .select()
      .from(documentReadingEvents)
      .where(and(eq(documentReadingEvents.documentId, doc.id)));
    expect(events).toHaveLength(1);
  });

  it("one workspace cannot read or record another's documents", async () => {
    const a = await seed("reading-tenant-a");
    const b = await seed("reading-tenant-b");
    await expect(
      reading.recordReadingEvent(b.auth, {
        documentId: a.doc.id,
        visitId: crypto.randomUUID(),
        kind: "opened",
      }),
    ).rejects.toThrow(/does not exist/);
    expect(await reading.getReadableDocument(b.auth, a.doc.id)).toBeNull();
  });

  it("the library lists unread and in-progress documents with their state", async () => {
    const { auth, doc } = await seed("reading-library");
    const [unreadDoc] = await db
      .insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "unread.pdf" })
      .returning();
    const visitId = crypto.randomUUID();
    await reading.recordReadingEvent(auth, { documentId: doc.id, visitId, kind: "opened" });
    await reading.recordReadingEvent(auth, { documentId: doc.id, visitId, kind: "progress", progress: 0.5, activeSeconds: 300 });

    const rows = await reading.listLibrary(auth);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(reading.libraryGroup(byId.get(doc.id)!)).toBe("continue");
    expect(reading.libraryGroup(byId.get(unreadDoc.id)!)).toBe("unread");
    expect(byId.get(doc.id)?.state).toMatchObject({ openCount: 1, totalActiveSeconds: 300 });

    const history = await reading.readingHistory(auth);
    expect(history.map((row) => row.documentId)).toContain(doc.id);
    expect(history.map((row) => row.documentId)).not.toContain(unreadDoc.id);
  });
});
