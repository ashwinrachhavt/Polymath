import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { briefingSeeds, tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * briefing_seeds against real Postgres. The shutdown ritual has been writing
 * these since ASH-305 with no reader; these are the invariants the reader has
 * to honour, because a wrong one silently asks the owner to commit work that
 * is already done or already declined.
 *
 * Skipped without TEST_DATABASE_URL (CI provides it).
 */

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
let seeds: typeof import("@/domains/work/seeds");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = handle.db;
  seeds = await import("@/domains/work/seeds");
});

afterAll(async () => {
  await handle?.client.end();
});

async function workspace(tag: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `seeds-${tag}-${Date.now()}`);
  return { auth: ownerAuth(userId, workspaceId), workspaceId };
}

async function task(workspaceId: string, title: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const [row] = await db.insert(tasks).values({ workspaceId, title, rank: "m", status: "ready", ...over }).returning();
  return row;
}

async function seed(workspaceId: string, taskId: string, onDate = "2026-10-27") {
  const [row] = await db
    .insert(briefingSeeds)
    .values({ workspaceId, onDate, taskId, reason: "Carried over by the end-of-day shutdown" })
    .returning();
  return row;
}

suite("briefing seeds", () => {
  it("offers only live suggestions: a finished, cancelled or archived task is not suggested", async () => {
    const { auth, workspaceId } = await workspace("live");
    const open = await task(workspaceId, "Outline the talk");
    const done = await task(workspaceId, "Send the invoice", { status: "done" });
    const gone = await task(workspaceId, "Archived idea", { archivedAt: new Date() });
    await seed(workspaceId, open.id);
    await seed(workspaceId, done.id);
    await seed(workspaceId, gone.id);

    const rows = await seeds.listSeedsForDay(auth, "2026-10-27");
    expect(rows.map((row) => row.title)).toEqual(["Outline the talk"]);
  });

  it("never reads another workspace's suggestions", async () => {
    const mine = await workspace("mine");
    const theirs = await workspace("theirs");
    const theirTask = await task(theirs.workspaceId, "Their task");
    await seed(theirs.workspaceId, theirTask.id);

    const rows = await seeds.listSeedsForDay(mine.auth, "2026-10-27");
    expect(rows).toEqual([]);
  });

  it("dismissing archives the row and the same day's replay cannot revive it", async () => {
    const { auth, workspaceId } = await workspace("dismiss");
    const t = await task(workspaceId, "Draft the memo");
    const row = await seed(workspaceId, t.id);

    const dismissed = await seeds.dismissSeed(auth, { seedId: row.id, expectedVersion: row.version });
    expect(dismissed?.version).toBe(row.version + 1);

    // Archived, not deleted: the unique key still holds, so the shutdown's
    // own insert-on-conflict-do-nothing cannot bring it back.
    const [stored] = await db.select().from(briefingSeeds).where(eq(briefingSeeds.id, row.id));
    expect(stored.archivedAt).not.toBeNull();
    const rows = await seeds.listSeedsForDay(auth, "2026-10-27");
    expect(rows).toEqual([]);
  });

  it("refuses a dismiss at a stale version instead of clobbering a newer one", async () => {
    const { auth, workspaceId } = await workspace("stale");
    const t = await task(workspaceId, "Call the bank");
    const row = await seed(workspaceId, t.id);
    await seeds.dismissSeed(auth, { seedId: row.id, expectedVersion: row.version });

    const again = await seeds.dismissSeed(auth, { seedId: row.id, expectedVersion: row.version });
    expect(again).toBeNull();
  });

  it("committing a suggestion archives it, so it stops being offered", async () => {
    const { auth, workspaceId } = await workspace("commit");
    const t = await task(workspaceId, "Plan the week");
    const row = await seed(workspaceId, t.id);

    await seeds.markSeedCommitted(auth, row.id);

    const rows = await seeds.listSeedsForDay(auth, "2026-10-27");
    expect(rows).toEqual([]);
  });
});
