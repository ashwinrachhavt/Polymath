import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentProfiles, messageComments, messages, threads } from "@/domains/agents/schema";
import { memberships, users } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for margin comments on a chat message (plan Task 7):
 * the comment and its audit row commit or not together, another workspace can
 * neither read nor touch the comment, a fellow member cannot read someone's
 * supervisor thread's comments (ASH-306), resolve/reopen toggles the visible
 * state and never deletes, and deleting the thread takes its comments with
 * it. The migration under test is 0272_message_comments_and_proposal_sources.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let domain: typeof import("@/domains/agents/message-comments");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  domain = await import("@/domains/agents/message-comments");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seedThread(workspaceId: string, userId: string, subjectType: string | null = null) {
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: "Alfred" })
    .returning({ id: agentProfiles.id });
  const [thread] = await db
    .insert(threads)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      ...(subjectType === null ? {} : { subjectType, subjectId: userId }),
    })
    .returning({ id: threads.id });
  const [message] = await db
    .insert(messages)
    .values({ workspaceId, threadId: thread.id, role: "assistant", content: "The recorded answer." })
    .returning({ id: messages.id });
  return { threadId: thread.id, messageId: message.id };
}

/** A second user inside the SAME workspace - the ASH-306 adversary. */
async function secondMember(workspaceId: string, slug: string): Promise<AuthContext> {
  const [user] = await db
    .insert(users)
    .values({ clerkUserId: `tw_${slug}` })
    .returning();
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: "member", status: "active" });
  return { userId: user.id, workspaceId, role: "member" as const };
}

suite("message comments", () => {
  it("creates the comment and its audit row in one transaction, and replays the idempotency key", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `msgc-create-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const { messageId } = await seedThread(workspaceId, userId);

    const comment = await domain.addMessageComment(auth, { messageId, body: "  Expand the rollout section.  " });
    expect(comment.body).toBe("Expand the rollout section.");
    expect(comment.resolvedAt).toBeNull();

    // One insert, one audit row: a change with no audit row did not happen.
    const audits = await db
      .select({ action: auditEvents.action, subjectId: auditEvents.subjectId })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.subjectId, messageId)));
    expect(audits.map((a) => a.action)).toContain("message.comment_added");

    // The same key replays the stored comment instead of writing a twin.
    const keyed = "11111111-1111-4111-8111-111111111111";
    const first = await domain.addMessageComment(auth, {
      messageId,
      body: "Expand the rollout section.",
      idempotencyKey: keyed,
    });
    const replay = await domain.addMessageComment(auth, {
      messageId,
      body: "Expand the rollout section.",
      idempotencyKey: keyed,
    });
    expect(replay.id).toBe(first.id);
    const listed = await domain.listMessageComments(auth, messageId);
    expect(listed.filter((c) => c.body === "Expand the rollout section.")).toHaveLength(2);

    // Blank and overlong bodies are refused before anything is written.
    await expect(domain.addMessageComment(auth, { messageId, body: "   " })).rejects.toMatchObject({
      code: "message_comment_invalid",
    });
    await expect(domain.addMessageComment(auth, { messageId, body: "x".repeat(2001) })).rejects.toMatchObject({
      code: "message_comment_invalid",
    });
  });

  it("keeps one workspace's comments invisible to another", async () => {
    const one = await seedWorkspace(db, `msgc-ten-a-${Date.now()}`);
    const two = await seedWorkspace(db, `msgc-ten-b-${Date.now()}`);
    const authOne = ownerAuth(one.userId, one.workspaceId);
    const authTwo = ownerAuth(two.userId, two.workspaceId);
    const { messageId } = await seedThread(one.workspaceId, one.userId);

    const comment = await domain.addMessageComment(authOne, { messageId, body: "Internal margin note." });
    await expect(domain.listMessageComments(authTwo, messageId)).rejects.toMatchObject({
      code: "message_comment_invalid",
    });
    await expect(
      domain.resolveMessageComment(authTwo, { commentId: comment.id, resolved: true }),
    ).rejects.toMatchObject({ code: "message_comment_invalid" });
    // The refused resolve wrote nothing: no audit rows exist for the comment.
    const refused = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, comment.id));
    expect(refused).toHaveLength(0);
    const listed = await domain.listMessageComments(authOne, messageId);
    expect(listed).toHaveLength(1);
    expect(listed[0].resolvedAt).toBeNull();
  });

  it("hides a supervisor thread's comments from a fellow member (ASH-306)", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `msgc-sup-${Date.now()}`);
    const owner = ownerAuth(userId, workspaceId);
    const peer = await secondMember(workspaceId, `msgc-peer-${Date.now()}`);
    const { messageId } = await seedThread(workspaceId, userId, "supervisor");

    await domain.addMessageComment(owner, { messageId, body: "Private margin note." });
    await expect(domain.listMessageComments(peer, messageId)).rejects.toMatchObject({
      code: "message_comment_invalid",
    });
    // Adding is gated the same way: the peer cannot write onto the owner's
    // private exchange, indistinguishably from a wrong message id.
    await expect(domain.addMessageComment(peer, { messageId, body: "Peer note." })).rejects.toMatchObject({
      code: "message_comment_invalid",
    });
    const listed = await domain.listMessageComments(owner, messageId);
    expect(listed).toHaveLength(1);
  });

  it("resolves and reopens, recording each turn", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `msgc-resolve-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const { messageId } = await seedThread(workspaceId, userId);

    const comment = await domain.addMessageComment(auth, { messageId, body: "Check the number." });
    const resolved = await domain.resolveMessageComment(auth, { commentId: comment.id, resolved: true });
    expect(resolved.resolvedAt).not.toBeNull();

    let listed = await domain.listMessageComments(auth, messageId);
    expect(listed[0].resolvedAt).not.toBeNull();

    const reopened = await domain.resolveMessageComment(auth, { commentId: comment.id, resolved: false });
    expect(reopened.resolvedAt).toBeNull();
    listed = await domain.listMessageComments(auth, messageId);
    expect(listed[0].resolvedAt).toBeNull();

    // Resolve/reopen audits point at the message; the comment id rides in metadata.
    const actions = await db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, messageId));
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["message.comment_resolved", "message.comment_reopened"]),
    );
    expect(actions.some((a) => (a.metadata as { commentId?: string } | null)?.commentId === comment.id)).toBe(true);

    // Resolve never deletes: the row survives with its visible state toggled.
    const rows = await db
      .select({ id: messageComments.id, archivedAt: messageComments.archivedAt })
      .from(messageComments)
      .where(eq(messageComments.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(comment.id);
  });

  it("cascades a thread delete to its comments", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `msgc-cascade-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const { threadId, messageId } = await seedThread(workspaceId, userId);
    await domain.addMessageComment(auth, { messageId, body: "Gone with the thread." });

    await db.delete(threads).where(eq(threads.id, threadId));

    const rows = await db
      .select({ id: messageComments.id })
      .from(messageComments)
      .where(and(eq(messageComments.workspaceId, workspaceId)));
    expect(rows).toHaveLength(0);
  });
});
