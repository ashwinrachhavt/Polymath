import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * 0266_converge_push_schema heals any historical push-era schema to current.
 * Every statement is additive or catalog-guarded, so running it on an already
 * current database must change nothing. The proof: execute the whole script
 * twice against the real test database (whose schema the CI setup migrates to
 * current) and require both runs to succeed with a byte-identical
 * information_schema snapshot in between — columns, indexes, constraints.
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
  it("runs twice with a byte-identical schema snapshot in between", async () => {
    if (!handle) throw new Error("unreachable");
    const script = readFileSync(CONVERGE_FILE, "utf8");
    expect(script).toContain("CREATE TABLE IF NOT EXISTS");

    const before = await schemaSnapshot(handle.client);
    await handle.client.unsafe(script);
    const afterFirst = await schemaSnapshot(handle.client);
    await handle.client.unsafe(script);
    const afterSecond = await schemaSnapshot(handle.client);

    // The test database starts at the current schema, so both runs are pure
    // no-ops — the invariant that keeps the converge safe on prod and on any
    // historical state is that neither run changes anything.
    expect(afterFirst).toBe(before);
    expect(afterSecond).toBe(afterFirst);
  });
});
