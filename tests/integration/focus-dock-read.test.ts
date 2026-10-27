import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The app shell's focus dock reads the same live session Work controls
 * (getLiveFocusDock): scoped to the workspace, running or paused only, named by
 * the task (or the subject), gone once the session ends or is abandoned.
 */

// The code under test reads the module-level db and withTransaction; point both at the test database.
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/focus/commands");
let queries: typeof import("@/domains/focus/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = handle.db;
  commands = await import("@/domains/focus/commands");
  queries = await import("@/domains/focus/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function workspace(tag: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `dock-${tag}-${Date.now()}`);
  return { auth: ownerAuth(userId, workspaceId), workspaceId };
}

suite("focus dock read", () => {
  it("is null with no live session", async () => {
    const { auth } = await workspace("none");
    expect(await queries.getLiveFocusDock(auth)).toBeNull();
  });

  it("names a running session by its task, then paused, then null once finished", async () => {
    const { auth, workspaceId } = await workspace("task");
    const [task] = await db.insert(tasks).values({ workspaceId, title: "Draft the Q4 memo", rank: "m", status: "ready" }).returning();
    const session = await commands.startFocusSession(auth, { taskId: task.id });
    expect(await queries.getLiveFocusDock(auth)).toEqual({ id: session.id, state: "running", title: "Draft the Q4 memo" });

    const paused = await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: session.version });
    expect(await queries.getLiveFocusDock(auth)).toMatchObject({ id: session.id, state: "paused" });

    await commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: paused.version });
    expect(await queries.getLiveFocusDock(auth)).toBeNull();
  });

  it("falls back to the subject, and an abandoned session is gone", async () => {
    const { auth } = await workspace("subject");
    const session = await commands.startFocusSession(auth, { subject: "Think about pricing" });
    expect(await queries.getLiveFocusDock(auth)).toMatchObject({ title: "Think about pricing" });
    await commands.abandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version });
    expect(await queries.getLiveFocusDock(auth)).toBeNull();
  });

  it("never shows another workspace's session", async () => {
    const mine = await workspace("mine");
    const theirs = await workspace("theirs");
    await commands.startFocusSession(theirs.auth, { subject: "Their private focus" });
    expect(await queries.getLiveFocusDock(mine.auth)).toBeNull();
  });
});
