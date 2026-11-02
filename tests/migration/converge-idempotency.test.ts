import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * 0266_converge_push_schema heals any historical push-era schema to current.
 * Its statements are additive or catalog-guarded, so a second run must be a
 * no-op: the second execution has to leave the schema exactly as the first one
 * did. That is the invariant that keeps a re-run safe on prod — a converge that
 * kept accumulating objects on every run would drift a database it was meant to
 * heal.
 *
 * The first run is deliberately NOT required to be a no-op. 0266 carries the
 * full historical chain's `CREATE TABLE IF NOT EXISTS` bodies, including tables
 * that later migrations retired (cards, areas, the sitting tables, learning_*,
 * the pre-rename dossier tables). On a database that is already current those
 * creates run for real and resurrect empty tables, which is the defect
 * 0269_drop_retired_tables exists to clean up. 0269 has already run when this
 * test starts, so the first converge legitimately re-adds them; asserting it
 * changed nothing would fail on correct behaviour.
 *
 * Because that first run leaves the database dirty, this file removes the
 * resurrected tables again before it finishes. Every other suite then runs
 * against the schema its migrations actually describe — without this cleanup,
 * a converge run early in the file order silently puts back tables that
 * tests/migration/schema-at-head.test.ts asserts are gone.
 *
 * The script runs as one multi-statement simple query, the same way
 * drizzle-kit applies a migration; DO-block bodies never need splitting.
 */

const CONVERGE_FILE = "src/db/migrations/0266_converge_push_schema.sql";
/** The retirement that undoes 0266's resurrected tables; re-applied on cleanup. */
const RETIRE_FILE = "src/db/migrations/0269_drop_retired_tables.sql";

async function schemaSnapshot(sql: postgres.Sql): Promise<string> {
  const columns = await sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `;
  const indexes = await sql`
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
    order by tablename, indexname
  `;
  const constraints = await sql`
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where connamespace = 'public'::regnamespace
    order by table_name, conname
  `;
  return JSON.stringify({ columns, indexes, constraints });
}

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

beforeAll(() => {
  if (!handle) return;
});

afterAll(async () => {
  // Put the database back where the migration chain left it. Re-apply just the
  // retirement (0269) rather than hand-listing tables, so this cleanup can
  // never drift from the migration that owns the definition.
  if (handle) {
    await handle.client.unsafe(readFileSync(RETIRE_FILE, "utf8"));
  }
  await handle?.client.end();
});

suite("0266 converge idempotency", () => {
  it("settles after one run: the second leaves the schema byte-identical", async () => {
    if (!handle) throw new Error("unreachable");
    const script = readFileSync(CONVERGE_FILE, "utf8");
    expect(script).toContain("CREATE TABLE IF NOT EXISTS");

    await handle.client.unsafe(script);
    const afterFirst = await schemaSnapshot(handle.client);
    await handle.client.unsafe(script);
    const afterSecond = await schemaSnapshot(handle.client);

    // Convergence, not inertness: the first run is allowed to add the retired
    // tables 0266 still carries creates for (0269 drops them again), but the
    // second must change nothing or the script is not idempotent.
    expect(afterSecond).toBe(afterFirst);
  });
});
