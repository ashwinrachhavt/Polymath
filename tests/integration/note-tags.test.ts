import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Category tags on notes (ASH-174, Notes tab revamp): tags normalize the way
 * document tags do, the compare-and-set on the artifact version still guards
 * them, the list filter and the distinct-tag read agree, and every change is
 * audited. Real Postgres because the tag filter is a jsonb containment query.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let notes: typeof import("@/domains/knowledge/notes");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  notes = await import("@/domains/knowledge/notes");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

suite("note category tags", () => {
  it("normalizes, dedupes and persists tags, audited", async () => {
    const auth = await seed("tags-basic");
    const created = await notes.createNote(auth, { title: "Tagged note", idempotencyKey: crypto.randomUUID() });
    const result = await notes.setNoteTags(auth, {
      artifactId: created.id,
      expectedVersion: 1,
      tags: ["  Research ", "RESEARCH", "Ideas", "", "x".repeat(80)],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.tags).toEqual(["research", "ideas"]);
    const detail = await notes.getNote(auth, created.id);
    expect(detail?.tags).toEqual(["research", "ideas"]);
    expect(detail?.kind).toBe("note");
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "note.tags_changed"), eq(auditEvents.subjectId, created.id)));
    expect(audit).toHaveLength(1);
  });

  it("rejects a stale expectedVersion", async () => {
    const auth = await seed("tags-cas");
    const created = await notes.createNote(auth, { title: "CAS note", idempotencyKey: crypto.randomUUID() });
    await notes.setNoteTags(auth, { artifactId: created.id, expectedVersion: 1, tags: ["a"], idempotencyKey: crypto.randomUUID() });
    await expect(
      notes.setNoteTags(auth, { artifactId: created.id, expectedVersion: 1, tags: ["b"], idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const detail = await notes.getNote(auth, created.id);
    expect(detail?.tags).toEqual(["a"]);
  });

  it("replays the same idempotency key without a second audit row", async () => {
    const auth = await seed("tags-idem");
    const created = await notes.createNote(auth, { title: "Idem note", idempotencyKey: crypto.randomUUID() });
    const key = crypto.randomUUID();
    const first = await notes.setNoteTags(auth, { artifactId: created.id, expectedVersion: 1, tags: ["a"], idempotencyKey: key });
    const replay = await notes.setNoteTags(auth, { artifactId: created.id, expectedVersion: 1, tags: ["a"], idempotencyKey: key });
    expect(replay).toEqual(first);
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "note.tags_changed"), eq(auditEvents.subjectId, created.id)));
    expect(audit).toHaveLength(1);
  });

  it("filters the page by tag and lists distinct tags", async () => {
    const auth = await seed("tags-filter");
    const a = await notes.createNote(auth, { title: "Alpha", idempotencyKey: crypto.randomUUID() });
    const b = await notes.createNote(auth, { title: "Beta", idempotencyKey: crypto.randomUUID() });
    await notes.createNote(auth, { title: "Gamma", idempotencyKey: crypto.randomUUID() });
    await notes.setNoteTags(auth, { artifactId: a.id, expectedVersion: 1, tags: ["research"], idempotencyKey: crypto.randomUUID() });
    await notes.setNoteTags(auth, { artifactId: b.id, expectedVersion: 1, tags: ["research", "ideas"], idempotencyKey: crypto.randomUUID() });

    const research = await notes.pageNotes(auth, { tag: "research", limit: 10, offset: 0 });
    expect(research.total).toBe(2);
    expect(research.items.map((n) => n.title).sort()).toEqual(["Alpha", "Beta"]);
    expect(research.items.find((n) => n.id === b.id)?.tags).toEqual(["research", "ideas"]);

    const ideas = await notes.pageNotes(auth, { tag: "ideas", limit: 10, offset: 0 });
    expect(ideas.items.map((n) => n.title)).toEqual(["Beta"]);

    const untagged = await notes.pageNotes(auth, { limit: 10, offset: 0 });
    expect(untagged.total).toBe(3);

    expect(await notes.listNoteTags(auth)).toEqual(["ideas", "research"]);
  });

  it("rejects tags on a missing note", async () => {
    const auth = await seed("tags-missing");
    await expect(
      notes.setNoteTags(auth, { artifactId: crypto.randomUUID(), expectedVersion: 1, tags: ["a"], idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "note_not_found" });
  });
});
