import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, requestReceipts } from "@/domains/audit/schema";
import { focusSessions } from "@/domains/focus/schema";
import { users, workspaces } from "@/domains/identity/schema";
import { taskLinks, tasks } from "@/domains/work/schema";
import { seedTaskWithNote } from "../helpers/task-note";

/*
 * The invariants agents/engineering.md says run against real Postgres, because
 * a mock proves the mock works. These are the ones a later caller can break
 * without noticing: idempotency must dedupe, tenancy must cascade and isolate,
 * and a stale write must be rejected rather than silently won.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied — CI has no Postgres service yet, and a skipped test beats a test
 * that quietly passes against nothing. That skip is a real coverage hole: read
 * green CI as covering the schema, not these four.
 */

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  if (!url) return;
  client = postgres(url, { max: 1 });
  db = drizzle(client);
});

afterAll(async () => {
  await client?.end();
});

suite("reliability primitives", () => {
  // Each test seeds its own tenant; leftovers from a previous run would collide
  // on the unique keys rather than proving anything.
  beforeAll(async () => {
    if (!url) return;
    // Everything below deletes every row in the schema. Refuse to do that to
    // the application database, because pointing the two at the same URL is
    // the obvious mistake and it costs the owner their data.
    if (url === process.env.DATABASE_URL) {
      throw new Error(
        "TEST_DATABASE_URL equals DATABASE_URL. This suite truncates every table; use a scratch database or a Neon branch.",
      );
    }
    await client.unsafe(
      `do $$ declare t text; begin for t in
         select tablename from pg_tables where schemaname = 'public'
       loop execute format('truncate table %I cascade', t); end loop; end $$;`,
    );
  });

  async function seedWorkspace(slug: string) {
    const [user] = await db.insert(users).values({ clerkUserId: `clerk_${slug}` }).returning();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: slug, slug, createdBy: user.id })
      .returning();
    return { user, workspace };
  }

  it("an idempotency key can only be stored once per workspace", async () => {
    const { workspace } = await seedWorkspace("idempotency");
    const values = {
      workspaceId: workspace.id,
      idempotencyKey: "capture-1",
      requestHash: "abc",
    };
    await db.insert(requestReceipts).values(values);

    // Drizzle wraps driver errors, so the SQLSTATE lives on the cause.
    const replay = await db.insert(requestReceipts).values(values).catch((e) => e);
    expect((replay as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });

  it("the same key in another workspace is a different request", async () => {
    const a = await seedWorkspace("idempotency-a");
    const b = await seedWorkspace("idempotency-b");
    const values = { idempotencyKey: "shared-key", requestHash: "abc" };
    await db.insert(requestReceipts).values({ ...values, workspaceId: a.workspace.id });
    await db.insert(requestReceipts).values({ ...values, workspaceId: b.workspace.id });

    const rows = await db
      .select()
      .from(requestReceipts)
      .where(eq(requestReceipts.idempotencyKey, "shared-key"));
    expect(rows).toHaveLength(2);
  });

  it("archiving a workspace takes its rows with it", async () => {
    const { workspace } = await seedWorkspace("cascade");
    await seedTaskWithNote(db, { workspaceId: workspace.id, title: "Goes with the tenant" });
    await db.insert(auditEvents).values({
      workspaceId: workspace.id,
      action: "task.created",
      subjectType: "task",
      summary: "Created a task",
    });

    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));

    const orphans = await db.select().from(tasks).where(eq(tasks.workspaceId, workspace.id));
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspace.id));
    expect(orphans).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("a stale write is rejected, and a fresh one wins", async () => {
    const { workspace } = await seedWorkspace("versions");
    const task = await seedTaskWithNote(db, { workspaceId: workspace.id, title: "Versioned" });
    expect(task.version).toBe(1);

    // A caller that read version 1 and is writing again, guarded on that read.
    // The edited column is `priority` because the prose moved to the note in
    // 0260; the invariant under test is the version guard, not the column.
    const stale = await db
      .update(tasks)
      .set({ priority: "high", version: 2, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, 1)))
      .returning();
    expect(stale).toHaveLength(1);

    // The same guard, run again from the same stale read, matches nothing.
    const second = await db
      .update(tasks)
      .set({ priority: "low", version: 2, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, 1)))
      .returning();
    expect(second).toHaveLength(0);

    const [current] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(current.priority).toBe("high");
  });

  /*
   * The focus table documents "at most one live session per workspace; two tabs
   * cannot both own the clock". That is only true because the index is unique —
   * as a plain index it enforced nothing while the comment claimed it did.
   */
  it("a workspace cannot hold two live focus sessions", async () => {
    const { workspace } = await seedWorkspace("focus");
    await db.insert(focusSessions).values({ workspaceId: workspace.id, state: "running" });

    const second = await db
      .insert(focusSessions)
      .values({ workspaceId: workspace.id, state: "running" })
      .catch((e) => e);
    expect((second as { cause?: { code?: string } }).cause?.code).toBe("23505");

    // A finished session is not live, so it does not contend for the clock.
    await db.insert(focusSessions).values({ workspaceId: workspace.id, state: "finished" });
  });

  /*
   * `target_id` carries no foreign key, so the check constraint is the only
   * thing standing between a typo and an unqueryable link row. Without this
   * test the constraint is a comment again the moment someone edits it out.
   */
  it("a link row rejects a target kind that is not on the shared list", async () => {
    const { workspace } = await seedWorkspace("link-kinds");
    const task = await seedTaskWithNote(db, { workspaceId: workspace.id, title: "Linking" });

    await expect(
      db.insert(taskLinks).values({
        workspaceId: workspace.id,
        taskId: task.id,
        targetType: "typo_kind",
        targetId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
