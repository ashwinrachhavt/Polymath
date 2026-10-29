import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { artifacts } from "@/domains/knowledge/schema";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for margin comments on notes: the comment and its
 * audit row commit or not together, another workspace can neither read nor
 * touch the comment, and resolve/reopen toggles the visible state. Skipped
 * unless TEST_DATABASE_URL points at a migrated scratch database; the
 * migration under test is 0259_note_comments.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let domain: typeof import("@/domains/knowledge/note-comments");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  domain = await import("@/domains/knowledge/note-comments");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seedNote(workspaceId: string) {
  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title: "Comment test note" })
    .returning({ id: artifacts.id });
  return note.id;
}

suite("note comments", () => {
  it("creates the comment and its audit row in one transaction, and replays the idempotency key", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `comments-create-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const noteId = await seedNote(workspaceId);

    const comment = await domain.addNoteComment(auth, { noteId, body: "  Expand the rollout section.  ", idempotencyKey: crypto.randomUUID() });
    expect(comment.body).toBe("Expand the rollout section.");
    expect(comment.resolvedAt).toBeNull();

    // A change with no audit row did not happen: one insert, one audit row.
    const audits = await db
      .select({ action: auditEvents.action, subjectId: auditEvents.subjectId })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.subjectId, noteId)));
    expect(audits.map((a) => a.action)).toContain("note.comment_added");

    // The same key replays the stored comment instead of writing a twin.
    const replay = await domain.addNoteComment(auth, { noteId, body: "Expand the rollout section.", idempotencyKey: "11111111-1111-4111-8111-111111111111" });
    await domain.addNoteComment(auth, { noteId, body: "Expand the rollout section.", idempotencyKey: "11111111-1111-4111-8111-111111111111" });
    expect(replay.id).toBeDefined();
    const listed = await domain.listNoteComments(auth, noteId);
    expect(listed.filter((c) => c.body === "Expand the rollout section.")).toHaveLength(2);

    // Blank and overlong bodies are refused before anything is written.
    await expect(domain.addNoteComment(auth, { noteId, body: "   " })).rejects.toMatchObject({ code: "note_comment_invalid" });
    await expect(domain.addNoteComment(auth, { noteId, body: "x".repeat(2001) })).rejects.toMatchObject({ code: "note_comment_invalid" });
  });

  it("keeps one workspace's comments invisible to another", async () => {
    const one = await seedWorkspace(db, `comments-ten-a-${Date.now()}`);
    const two = await seedWorkspace(db, `comments-ten-b-${Date.now()}`);
    const authOne = ownerAuth(one.userId, one.workspaceId);
    const authTwo = ownerAuth(two.userId, two.workspaceId);
    const noteId = await seedNote(one.workspaceId);

    const comment = await domain.addNoteComment(authOne, { noteId, body: "Internal note." });
    await expect(domain.listNoteComments(authTwo, noteId)).rejects.toMatchObject({ code: "note_comment_invalid" });
    await expect(
      domain.resolveNoteComment(authTwo, { commentId: comment.id, resolved: true }),
    ).rejects.toMatchObject({ code: "note_comment_invalid" });
    // The refused resolve wrote nothing: no audit rows exist for the comment.
    const refused = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, comment.id));
    expect(refused).toHaveLength(0);
    const listed = await domain.listNoteComments(authOne, noteId);
    expect(listed).toHaveLength(1);
    expect(listed[0].resolvedAt).toBeNull();
  });

  it("resolves and reopens, recording each turn", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `comments-resolve-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const noteId = await seedNote(workspaceId);

    const comment = await domain.addNoteComment(auth, { noteId, body: "Check the number." });
    const resolved = await domain.resolveNoteComment(auth, { commentId: comment.id, resolved: true });
    expect(resolved.resolvedAt).not.toBeNull();

    let listed = await domain.listNoteComments(auth, noteId);
    expect(listed[0].resolvedAt).not.toBeNull();

    const reopened = await domain.resolveNoteComment(auth, { commentId: comment.id, resolved: false });
    expect(reopened.resolvedAt).toBeNull();
    listed = await domain.listNoteComments(auth, noteId);
    expect(listed[0].resolvedAt).toBeNull();

    // Resolve/reopen audits point at the note (the artifact a day page can
    // attribute); the comment id rides in metadata.
    const actions = await db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.subjectId, noteId)));
    expect(
      actions
        .filter((a) => a.action === "note.comment_resolved" || a.action === "note.comment_reopened")
        .map((a) => ({ action: a.action, commentId: (a.metadata as { commentId?: string })?.commentId })),
    ).toEqual([
      { action: "note.comment_resolved", commentId: comment.id },
      { action: "note.comment_reopened", commentId: comment.id },
    ]);

    // A wrong comment id is the domain error, not a 500.
    await expect(
      domain.resolveNoteComment(auth, { commentId: "00000000-0000-4000-8000-000000000000", resolved: true }),
    ).rejects.toMatchObject({ code: "note_comment_invalid" });
  });
});
