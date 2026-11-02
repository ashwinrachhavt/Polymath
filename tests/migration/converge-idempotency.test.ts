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
 * 0268_drop_retired_tables exists to clean up. 0268 runs before this test, so
 * the first converge legitimately re-adds them; asserting it changed nothing
 * would fail on correct behaviour.
 *
 * The script runs as one multi-statement simple query, the same way
 * drizzle-kit applies a migration; DO-block bodies never need splitting.
 */

const CONVERGE_FILE = "src/db/migrations/0266_converge_push_schema.sql";

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
    // tables 0266 still carries creates for (0268 drops them again), but the
    // second must change nothing or the script is not idempotent.
    expect(afterSecond).toBe(afterFirst);
  });
});
