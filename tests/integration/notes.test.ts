import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { artifactLinks, artifactVersions, workingDrafts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The notes core invariants that only real Postgres proves: a stale autosave
 * or commit is rejected rather than merged, a commit leaves every earlier
 * version intact, the draft/recovery fallback order holds, and a replayed
 * idempotency key creates nothing twice. Skipped without a scratch database,
 * same as the other suites.
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

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

suite("notes core", () => {
  it("creates, lists and reads a note with its audit row", async () => {
    const auth = await seed("notes-basic");
    const created = await notes.createNote(auth, { title: "First note", content: doc("hello"), plainText: "hello", idempotencyKey: crypto.randomUUID() });
    const list = await notes.listNotes(auth);
    expect(list.map((n) => n.id)).toContain(created.id);
    const detail = await notes.getNote(auth, created.id);
    expect(detail?.title).toBe("First note");
    expect(detail?.version).toBe(1);
    expect((detail?.content as { content: unknown[] }).content).toHaveLength(1);
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.subjectId, created.id), eq(auditEvents.action, "note.created")));
    expect(audits).toHaveLength(1);
  });

  it("replays a create under the same idempotency key without a second row", async () => {
    const auth = await seed("notes-idem");
    const key = crypto.randomUUID();
    const first = await notes.createNote(auth, { title: "Once", idempotencyKey: key });
    const second = await notes.createNote(auth, { title: "Once", idempotencyKey: key });
    expect(second.id).toBe(first.id);
    expect((await notes.listNotes(auth)).filter((n) => n.title === "Once")).toHaveLength(1);
  });

  it("autosaves under the version guard and rejects a stale write", async () => {
    const auth = await seed("notes-cas");
    const created = await notes.createNote(auth, { title: "CAS", idempotencyKey: crypto.randomUUID() });
    const saved = await notes.autosaveNoteDraft(auth, { artifactId: created.id, expectedVersion: 1, content: doc("draft one"), idempotencyKey: crypto.randomUUID() });
    expect(saved.version).toBe(2);
    await expect(
      notes.autosaveNoteDraft(auth, { artifactId: created.id, expectedVersion: 1, content: doc("stale"), idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    const detail = await notes.getNote(auth, created.id);
    expect(detail?.draft?.content).toEqual(doc("draft one"));
  });

  it("commits a snapshot, keeps history and clears the draft", async () => {
    const auth = await seed("notes-commit");
    const created = await notes.createNote(auth, { title: "History", content: doc("v1"), plainText: "v1", idempotencyKey: crypto.randomUUID() });
    await notes.autosaveNoteDraft(auth, { artifactId: created.id, expectedVersion: 1, content: doc("v2 draft"), idempotencyKey: crypto.randomUUID() });
    const committed = await notes.commitNoteSnapshot(auth, { artifactId: created.id, expectedVersion: 2, content: doc("v2"), plainText: "v2", idempotencyKey: crypto.randomUUID() });
    expect(committed.versionNumber).toBe(2);
    const versions = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, created.id)).orderBy(artifactVersions.versionNumber);
    expect(versions).toHaveLength(2);
    expect(versions[1].plainText).toBe("v2");
    const detail = await notes.getNote(auth, created.id);
    expect(detail?.draft).toBeNull();
    expect(detail?.content).toEqual(doc("v2"));
    await expect(
      notes.commitNoteSnapshot(auth, { artifactId: created.id, expectedVersion: 2, content: doc("stale commit"), idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("recovers from the working draft first, then the latest recovery copy", async () => {
    const auth = await seed("notes-recovery");
    const created = await notes.createNote(auth, { title: "Recovery", idempotencyKey: crypto.randomUUID() });
    await notes.autosaveNoteDraft(auth, { artifactId: created.id, expectedVersion: 1, content: doc("draft state"), idempotencyKey: crypto.randomUUID() });
    const fromDraft = await notes.recoverNoteDraft(auth, created.id);
    expect(fromDraft?.source).toBe("draft");
    expect(fromDraft?.content).toEqual(doc("draft state"));
    // The draft row is what a crash takes; the recovery copy must still answer.
    await db.delete(workingDrafts).where(eq(workingDrafts.artifactId, created.id));
    const fromCopy = await notes.recoverNoteDraft(auth, created.id);
    expect(fromCopy?.source).toBe("recovery");
    expect(fromCopy?.content).toEqual(doc("draft state"));
  });

  it("isolates notes by workspace", async () => {
    const a = await seed("notes-tenant-a");
    const b = await seed("notes-tenant-b");
    const created = await notes.createNote(a, { title: "Mine", idempotencyKey: crypto.randomUUID() });
    expect(await notes.getNote(b, created.id)).toBeNull();
    await expect(
      notes.autosaveNoteDraft(b, { artifactId: created.id, expectedVersion: 1, content: doc("intruder"), idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "note_not_found" });
  });

  it("resolves [[wiki links]] into edges and reads them back both ways", async () => {
    const auth = await seed("notes-links");
    const target = await notes.createNote(auth, { title: "Venue Shortlist", idempotencyKey: crypto.randomUUID() });
    const source = await notes.createNote(auth, { title: "Launch plan", idempotencyKey: crypto.randomUUID() });
    await notes.autosaveNoteDraft(auth, {
      artifactId: source.id,
      expectedVersion: 1,
      content: { format: "markdown", text: "Book from [[Venue Shortlist]] and keep [[Missing Note]] as text" },
      plainText: "Book from [[Venue Shortlist]] and keep [[Missing Note]] as text",
      idempotencyKey: crypto.randomUUID(),
    });
    // The resolved target becomes the only edge; the unmatched title stays prose.
    expect(await notes.listNoteOutlinks(auth, source.id)).toEqual([
      { id: target.id, title: "Venue Shortlist", kind: "note", linkType: "reference", context: null, excerpt: null },
    ]);
    expect(await notes.listNoteBacklinks(auth, target.id)).toEqual([
      { id: source.id, title: "Launch plan", kind: "note", linkType: "reference", context: null, excerpt: null },
    ]);
    // Titles match case-insensitively; the edge survives an unrelated edit.
    await notes.autosaveNoteDraft(auth, {
      artifactId: source.id,
      expectedVersion: 2,
      content: { format: "markdown", text: "still see [[venue shortlist]]" },
      plainText: "still see [[venue shortlist]]",
      idempotencyKey: crypto.randomUUID(),
    });
    expect((await notes.listNoteOutlinks(auth, source.id)).map((l) => l.id)).toEqual([target.id]);
    const rows = await db.select().from(artifactLinks).where(and(eq(artifactLinks.artifactId, source.id), eq(artifactLinks.targetType, "note")));
    expect(rows).toHaveLength(1);
  });

  /*
   * Value: protects=the list preview showing what the person last wrote, not
   * the last checkpoint; fails_when=an autosave-only note lists a blank
   * excerpt until its first explicit checkpoint; why_new=the excerpt query
   * changed to coalesce the working draft and no unit seam exists for SQL;
   * seam=notes.listNotes against real Postgres; no_claim=the page's
   * markdown-stripping render (display-title.test.ts owns that).
   */
  it("previews the working draft when there is no committed version yet", async () => {
    // Regression: the excerpt used to read plainText only, so an autosave-only
    // note — the normal case — listed a blank preview until the first
    // explicit checkpoint.
    const auth = await seed("notes-excerpt-draft");
    const created = await notes.createNote(auth, { title: "Draft only", idempotencyKey: crypto.randomUUID() });
    await notes.autosaveNoteDraft(auth, {
      artifactId: created.id,
      expectedVersion: 1,
      content: { format: "markdown", text: "# Working draft body" },
      idempotencyKey: crypto.randomUUID(),
    });
    const listed = (await notes.listNotes(auth)).find((n) => n.id === created.id);
    expect(listed?.excerpt).toBe("# Working draft body");
  });

  /*
   * Value: protects=the committed note's preview surviving the coalesce
   * reorder; fails_when=the draft leg of the coalesce shadows or breaks the
   * plainText fallback; why_new=same excerpt query change; seam=notes.listNotes
   * against real Postgres; no_claim=markdown rendering.
   */
  it("falls back to the committed plainText when no working draft exists", async () => {
    const auth = await seed("notes-excerpt-committed");
    const created = await notes.createNote(auth, { title: "Committed", content: doc("v1"), plainText: "committed body", idempotencyKey: crypto.randomUUID() });
    const listed = (await notes.listNotes(auth)).find((n) => n.id === created.id);
    expect(listed?.excerpt).toBe("committed body");
  });

  it("drops the edge when the reference leaves the body, and never self-links", async () => {
    const auth = await seed("notes-unlink");
    const target = await notes.createNote(auth, { title: "Glossary", idempotencyKey: crypto.randomUUID() });
    await notes.autosaveNoteDraft(auth, {
      artifactId: target.id,
      expectedVersion: 1,
      content: { format: "markdown", text: "see [[Glossary]]" },
      plainText: "see [[Glossary]]",
      idempotencyKey: crypto.randomUUID(),
    });
    // Self-reference is prose, not an edge.
    expect(await notes.listNoteOutlinks(auth, target.id)).toEqual([]);
    const source = await notes.createNote(auth, { title: "Reader", idempotencyKey: crypto.randomUUID() });
    await notes.commitNoteSnapshot(auth, {
      artifactId: source.id,
      expectedVersion: 1,
      content: { format: "markdown", text: "points at [[Glossary]]" },
      plainText: "points at [[Glossary]]",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await notes.listNoteBacklinks(auth, target.id)).toEqual([
      { id: source.id, title: "Reader", kind: "note", linkType: "reference", context: null, excerpt: "points at [[Glossary]]" },
    ]);
    await notes.commitNoteSnapshot(auth, {
      artifactId: source.id,
      expectedVersion: 2,
      content: { format: "markdown", text: "no links anymore" },
      plainText: "no links anymore",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await notes.listNoteBacklinks(auth, target.id)).toEqual([]);
  });
});

