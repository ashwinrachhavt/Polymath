import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { memberships, users, workspaces } from "@/domains/identity/schema";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";

/*
 * The scaffolding every integration suite repeats: point DATABASE_URL at the
 * scratch database, open one client, and seed an owner workspace. Extracted so
 * a fix here is a fix everywhere.
 *
 * No equality guard between TEST_DATABASE_URL and DATABASE_URL: the brief ruled
 * it out and the suites insert fresh unique slugs rather than truncating, so
 * pointing both at the same database is not the data-loss mistake it is in
 * reliability.test.ts (which still owns its own truncating beforeAll).
 */

export function makeTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  // In CI a missing database is a broken gate, not a reason to skip: the
  // suite would report green while every invariant it exists to prove never
  // ran. A local clone without a scratch DB is the only legitimate skip.
  if (!url && process.env.CI) {
    throw new Error(
      "CI must provide TEST_DATABASE_URL: the integration suites cannot silently skip.",
    );
  }
  if (!url) return null;
  // src/lib/db-transaction.ts reads DATABASE_URL at module load; point it here
  // before anything lazy-imports that module.
  process.env.DATABASE_URL = url;
  const client = postgres(url, { max: 3 });
  return { client, db: drizzle(client) };
}

export async function truncateAll(client: ReturnType<typeof postgres>) {
  await client.unsafe(`do $$ declare t text; begin for t in
    select tablename from pg_tables where schemaname = 'public'
    loop execute format('truncate table %I cascade', t); end loop; end $$;`);
}
void truncateAll; // exported for suites that opt into truncation; reliability.test.ts owns its own
export async function seedWorkspace(
  db: ReturnType<typeof drizzle>,
  slug: string,
): Promise<{ userId: string; workspaceId: string }> {
  const [user] = await db
    .insert(users)
    .values({ clerkUserId: `tw_${slug}` })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ name: slug, slug: `${slug}-${Date.now()}`, isPersonal: true })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: user.id, role: "owner", status: "active" });
  return { userId: user.id, workspaceId: ws.id };
}

/** The owner AuthContext every integration suite builds from seedWorkspace. */
export function ownerAuth(userId: string, workspaceId: string) {
  return { userId, workspaceId, role: "owner" as const };
}

/**
 * A task written straight to Postgres, standing on the note a task is now half
 * of: the artifact, its version 1, and the extension row pointing at it. Suites
 * that used to `insert(tasks)` alone get a row that the joined reads can see.
 *
 * The body is markdown, the shape `createTaskNote` writes, so the note renders
 * the same way a production task's does. A null body keeps the empty doc.
 */
export async function seedTask(
  db: ReturnType<typeof drizzle>,
  workspaceId: string,
  row: Omit<typeof tasks.$inferInsert, "workspaceId" | "noteId">,
): Promise<typeof tasks.$inferSelect> {
  const text = row.description?.trim() ? row.description : null;
  const [note] = await db
    .insert(artifacts)
    .values({
      workspaceId,
      kind: "note",
      title: row.title,
      template: "issue",
      ...(row.createdBy ? { createdBy: row.createdBy } : {}),
      ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId,
      artifactId: note.id,
      versionNumber: 1,
      content: text ? { format: "markdown", text } : { type: "doc", content: [] },
      plainText: text,
      reason: "created",
      ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, note.id));
  const [task] = await db
    .insert(tasks)
    .values({ ...row, workspaceId, noteId: note.id })
    .returning();
  return task;
}
