import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages, threads } from "@/domains/agents/schema";
import { eq } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Conversations surface integration coverage (ASH-140 D04): starting a
 * thread persists it (and its opening message) in Postgres, the list and
 * timeline read back from Postgres with message counts and ordering, and
 * another workspace's threads neither list nor read. The domain modules are
 * imported lazily so DATABASE_URL points at the scratch database before
 * db-transaction reads it - the same rule as spending.test.ts.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/conversations/commands");
let queries: typeof import("@/domains/conversations/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/conversations/commands");
  queries = await import("@/domains/conversations/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("conversations surface", () => {
  it("starts a thread with an opening message and reads it back in order", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `conv-basic-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const thread = await commands.createConversation(auth, {
      title: "Launch plan",
      openingMessage: "First draft by Friday.",
    });
    expect(thread.title).toBe("Launch plan");

    // Two more messages straight into the table: the timeline must render
    // them in written order.
    await db.insert(messages).values([
      { workspaceId, threadId: thread.id, role: "assistant", content: "Drafting now." },
      { workspaceId, threadId: thread.id, role: "user", content: "Add the pricing section." },
    ]);

    const conversation = await queries.getConversation(auth, thread.id);
    expect(conversation).not.toBeNull();
    expect(conversation!.thread.profileName).toBe("polymath");
    expect(conversation!.entries.map((e) => e.content)).toEqual([
      "First draft by Friday.",
      "Drafting now.",
      "Add the pricing section.",
    ]);
    expect(conversation!.entries.map((e) => e.role)).toEqual(["user", "assistant", "user"]);

    const list = await queries.listConversations(auth);
    const summary = list.find((c) => c.id === thread.id);
    expect(summary).toBeDefined();
    expect(summary!.messageCount).toBe(3);
    expect(summary!.profileName).toBe("polymath");
  });

  it("starts a title-only thread with an empty timeline", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `conv-empty-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const thread = await commands.createConversation(auth, { title: "Someday", openingMessage: null });
    const conversation = await queries.getConversation(auth, thread.id);
    expect(conversation!.entries).toEqual([]);
    const list = await queries.listConversations(auth);
    expect(list.find((c) => c.id === thread.id)!.messageCount).toBe(0);
  });

  it("keeps another workspace's threads out of the list and the timeline", async () => {
    const a = await seedWorkspace(db, `conv-ten-a-${Date.now()}`);
    const b = await seedWorkspace(db, `conv-ten-b-${Date.now()}`);
    const authA = ownerAuth(a.userId, a.workspaceId);
    const authB = ownerAuth(b.userId, b.workspaceId);

    const threadB = await commands.createConversation(authB, { title: "B only", openingMessage: "private" });

    expect((await queries.listConversations(authA)).some((c) => c.id === threadB.id)).toBe(false);
    expect(await queries.getConversation(authA, threadB.id)).toBeNull();
    expect((await queries.getConversation(authB, threadB.id))!.entries.length).toBe(1);
  });

  it("hides archived threads from the list", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `conv-arch-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const thread = await commands.createConversation(auth, { title: "Old", openingMessage: null });
    await db.update(threads).set({ archivedAt: new Date() }).where(eq(threads.id, thread.id));
    expect((await queries.listConversations(auth)).some((c) => c.id === thread.id)).toBe(false);
    expect(await queries.getConversation(auth, thread.id)).toBeNull();
  });
});
