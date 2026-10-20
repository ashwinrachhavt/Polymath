import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, messages, threads } from "@/domains/agents/schema";
import { outboxEvents } from "@/domains/audit/schema";
import { artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/* A message queues one debounced sync; the worker turns it into a transcript node, once. */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { queueThreadSync, THREAD_CHANGED_TOPIC } from "@/domains/knowledge/thread-sync-event";
import { syncThreadToGraph, threadChangedHandler } from "@/domains/knowledge/thread-graph";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

suite("conversation auto-sync (real Postgres)", () => {
  it("folds a burst into one event, due after the window, and syncs a node once", async () => {
    const db = holder.db!;
    const ws = await seedWorkspace(db, `ts-${crypto.randomUUID()}`);
    const auth = { workspaceId: ws.workspaceId, userId: ws.userId, role: "owner" as const };
    const [profile] = await db.insert(agentProfiles).values({ workspaceId: ws.workspaceId, name: `p-${crypto.randomUUID()}`, allowedTools: [] }).returning();
    const [thread] = await db.insert(threads).values({ workspaceId: ws.workspaceId, agentProfileId: profile.id, title: "Roadmap" }).returning();
    await db.insert(messages).values({ workspaceId: ws.workspaceId, threadId: thread.id, role: "user", content: "What ships first?" });

    const at = new Date("2026-01-01T10:00:20Z");
    await db.transaction(async (tx) => {
      await queueThreadSync(tx as never, ws.workspaceId, thread.id, at);
      await queueThreadSync(tx as never, ws.workspaceId, thread.id, new Date(at.getTime() + 15_000));
    });
    const rows = await db.select().from(outboxEvents).where(and(eq(outboxEvents.workspaceId, ws.workspaceId), eq(outboxEvents.topic, THREAD_CHANGED_TOPIC)));
    expect(rows).toHaveLength(1);
    expect(rows[0].availableAt.toISOString()).toBe("2026-01-01T10:01:02.000Z");

    const handler = threadChangedHandler(async () => auth);
    const run = () => handler({ workspaceId: ws.workspaceId, payload: { threadId: thread.id } } as never);
    await run();
    await run();
    const node = await syncThreadToGraph(auth, thread.id);
    expect(node.created).toBe(false);
    const versions = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, node.artifactId));
    expect(versions).toHaveLength(1);
  });

  it("completes quietly for an empty thread", async () => {
    const db = holder.db!;
    const ws = await seedWorkspace(db, `te-${crypto.randomUUID()}`);
    const auth = { ...ws, role: "owner" as const };
    const [profile] = await db.insert(agentProfiles).values({ workspaceId: ws.workspaceId, name: `p-${crypto.randomUUID()}`, allowedTools: [] }).returning();
    const [thread] = await db.insert(threads).values({ workspaceId: ws.workspaceId, agentProfileId: profile.id }).returning();
    await expect(threadChangedHandler(async () => auth)({ workspaceId: ws.workspaceId, payload: { threadId: thread.id } } as never)).resolves.toBeUndefined();
  });
});
