import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, requestReceipts } from "@/domains/audit/schema";
import { users, workspaces } from "@/domains/identity/schema";
import { tasks } from "@/domains/work/schema";

/*
 * The invariants agents/engineering.md says run against real Postgres, because
 * a mock proves the mock works. These are the ones a later caller can break
 * without noticing: idempotency must dedupe, tenancy must cascade and isolate,
 * and a stale write must be rejected rather than silently won.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied — CI has no Postgres service yet, and a skipped test beats a test
 * that quietly passes against nothing.
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
    await db.insert(tasks).values({ workspaceId: workspace.id, title: "Goes with the tenant" });
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
    const [task] = await db
      .insert(tasks)
      .values({ workspaceId: workspace.id, title: "Versioned" })
      .returning();
    expect(task.version).toBe(1);

    // A caller that read version 1 and is writing again, guarded on that read.
    const stale = await db
      .update(tasks)
      .set({ title: "Stale edit", version: 2, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, 1)))
      .returning();
    expect(stale).toHaveLength(1);

    // The same guard, run again from the same stale read, matches nothing.
    const second = await db
      .update(tasks)
      .set({ title: "Second stale edit", version: 2, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, 1)))
      .returning();
    expect(second).toHaveLength(0);

    const [current] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(current.title).toBe("Stale edit");
  });
});
