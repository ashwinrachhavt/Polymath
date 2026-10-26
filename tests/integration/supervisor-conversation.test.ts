import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages, threads } from "@/domains/agents/schema";
import { outboxEvents } from "@/domains/audit/schema";
import { memberships, users } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-306's ownership and persistence invariants, against real Postgres:
 * the Supervisor thread is per authenticated user within the workspace, a
 * concurrent first message never opens two threads, the exchange persists
 * with its card part, and another member's thread reads as "not here".
 * Skipped locally without TEST_DATABASE_URL; required in CI (test-workspace).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let respond: typeof import("@/domains/supervisor/respond");
let conversations: typeof import("@/domains/conversations/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  respond = await import("@/domains/supervisor/respond");
  conversations = await import("@/domains/conversations/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

let seedCounter = 0;

async function seedWithSecondMember(label: string) {
  seedCounter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${label}-${Date.now()}-${seedCounter}`);
  const [other] = await db.insert(users).values({ clerkUserId: `tw_${label}_other_${seedCounter}` }).returning();
  await db.insert(memberships).values({ workspaceId, userId: other.id, role: "member", status: "active" });
  return { owner: ownerAuth(userId, workspaceId), other: ownerAuth(other.id, workspaceId), workspaceId };
}

suite("respondToNavigation", () => {
  it("ordinary conversation returns null and opens no thread", async () => {
    const { owner } = await seedWithSecondMember("sup-none");
    const result = await respond.respondToNavigation(owner, "what did I capture yesterday");
    expect(result).toBeNull();
    const rows = await db.select({ id: threads.id }).from(threads)
      .where(and(eq(threads.workspaceId, owner.workspaceId), eq(threads.subjectType, "supervisor")));
    expect(rows).toHaveLength(0);
  });

  it("writes the exchange once and reuses the same thread on the next ask", async () => {
    const { owner } = await seedWithSecondMember("sup-reuse");
    const first = await respond.respondToNavigation(owner, "show my decisions");
    const second = await respond.respondToNavigation(owner, "show me my open tasks");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.threadId).toBe(first!.threadId);

    const rows = await db.select().from(messages)
      .where(eq(messages.threadId, first!.threadId))
      .orderBy(asc(messages.createdAt));
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const cardMessage = rows[1];
    const parts = cardMessage.parts as Array<{ type: string; card: { surface: string } }>;
    expect(parts[0].type).toBe("supervisor-surface");
    expect(parts[0].card.surface).toBe("decisions");
  });

  it("two concurrent first messages open exactly one thread for the owner", async () => {
    const { owner } = await seedWithSecondMember("sup-race");
    const [a, b] = await Promise.all([
      respond.respondToNavigation(owner, "show my decisions"),
      respond.respondToNavigation(owner, "show my decisions"),
    ]);
    expect(a!.threadId).toBe(b!.threadId);
    const rows = await db.select({ id: threads.id }).from(threads)
      .where(and(eq(threads.workspaceId, owner.workspaceId), eq(threads.subjectType, "supervisor")));
    expect(rows).toHaveLength(1);
  });

  it("never queues the private exchange for workspace-shared knowledge sync", async () => {
    const { owner } = await seedWithSecondMember("sup-noqueue");
    const reply = await respond.respondToNavigation(owner, "show my decisions");
    const forThread = await db.select({ id: outboxEvents.id }).from(outboxEvents)
      .where(and(
        eq(outboxEvents.workspaceId, owner.workspaceId),
        eq(outboxEvents.topic, "thread.changed"),
        sql`payload->>'threadId' = ${reply!.threadId}`,
      ));
    expect(forThread).toHaveLength(0);
  });

  it("the auto-sync handler skips supervisor threads even when an event exists", async () => {
    const { owner } = await seedWithSecondMember("sup-handlerskip");
    const reply = await respond.respondToNavigation(owner, "show my decisions");
    const { threadChangedHandler } = await import("@/domains/knowledge/thread-graph");
    const handler = threadChangedHandler(async () => owner);
    // A stale or hand-queued event for the private thread must not project it.
    await handler({ workspaceId: owner.workspaceId, payload: { threadId: reply!.threadId } } as never);
    const { artifactLinks } = await import("@/domains/knowledge/schema");
    const links = await db.select({ id: artifactLinks.id }).from(artifactLinks)
      .where(and(
        eq(artifactLinks.workspaceId, owner.workspaceId),
        eq(artifactLinks.targetType, "thread"),
        eq(artifactLinks.targetId, reply!.threadId),
      ));
    expect(links).toHaveLength(0);
  });

  it("a second member gets their own thread and cannot read the owner's", async () => {
    const { owner, other } = await seedWithSecondMember("sup-isolation");
    const ownerReply = await respond.respondToNavigation(owner, "show my decisions");
    const otherReply = await respond.respondToNavigation(other, "show my decisions");
    expect(otherReply!.threadId).not.toBe(ownerReply!.threadId);

    // Retrieval enforces the boundary: the owner's thread is not found for the other member.
    expect(await conversations.getConversation(other, ownerReply!.threadId)).toBeNull();
    expect(await conversations.getConversation(owner, ownerReply!.threadId)).not.toBeNull();
    // And the shared list hides the other member's private thread.
    const othersList = await conversations.listConversations(other);
    expect(othersList.map((t) => t.id)).not.toContain(ownerReply!.threadId);
    const ownersList = await conversations.listConversations(owner);
    expect(ownersList.map((t) => t.id)).toContain(ownerReply!.threadId);
  });

  it("a foreign workspace's supervisor thread reads as not found", async () => {
    const { owner } = await seedWithSecondMember("sup-cross-a");
    const { owner: stranger } = await seedWithSecondMember("sup-cross-b");
    const reply = await respond.respondToNavigation(owner, "show my decisions");
    expect(await conversations.getConversation(stranger, reply!.threadId)).toBeNull();
  });
});
