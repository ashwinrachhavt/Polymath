import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { memberships, users, workspaces } from "@/domains/identity/schema";

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

export function makeTestDb(options: { max?: number } = {}) {
  const url = process.env.TEST_DATABASE_URL;
  // A missing database is a broken gate everywhere, not just on CI: the files
  // that use this report green while every invariant they exist to prove never
  // ran. A local run once showed "274 passed | 179 skipped" — and the skips
  // included the migration suite that guards the converge script, so a broken
  // migration reached CI having passed "locally". Loud beats quiet.
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set: the integration and migration suites would skip silently. " +
        "Point it at a scratch database (see scripts/initdb/01-test-db.sql) or run the unit project.",
    );
  }
  // src/lib/db-transaction.ts reads DATABASE_URL at module load; point it here
  // before anything lazy-imports that module.
  process.env.DATABASE_URL = url;
  // truncateAll()'s TRUNCATE ... CASCADE emits one server NOTICE per cascaded
  // table on every call — ~35k NOTICE objects (7.8MB of log) per full gate
  // run, serialized through postgres-js's default onnotice. No suite asserts
  // driver notices (the .notices fields some tests read are app-level report
  // structures, not these), so drop them at the driver. Test helper only —
  // the dev server's db client (src/lib/db.ts) keeps its defaults.
  const client = postgres(url, { max: options.max ?? 3, onnotice: () => {} });
  return { client, db: drizzle(client) };
}

/** Tables migrations seed with reference data; truncating them would break every later suite. */
const SEEDED_REFERENCE_TABLES = ["stones"];

export async function truncateAll(client: ReturnType<typeof postgres>) {
  await client.unsafe(`do $$ declare t text; begin for t in
    select tablename from pg_tables where schemaname = 'public'
      and tablename not in (${SEEDED_REFERENCE_TABLES.map((t) => `'${t}'`).join(", ")})
    loop execute format('truncate table %I cascade', t); end loop; end $$;`);
}
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
  await db.insert(memberships).values({ workspaceId: ws.id, userId: user.id, role: "owner", status: "active" });
  return { userId: user.id, workspaceId: ws.id };
}

/** The owner AuthContext every integration suite builds from seedWorkspace. */
export function ownerAuth(userId: string, workspaceId: string) {
  return { userId, workspaceId, role: "owner" as const };
}
