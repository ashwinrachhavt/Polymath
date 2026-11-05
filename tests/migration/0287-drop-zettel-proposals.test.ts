import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * 0287 drops the zettel_proposals table and its status enum. Direct creation
 * (plan PRs 1-3) left the table without a writer and its read paths returning
 * stale rows; this migration is a pure subtraction - pending rows are
 * discarded (Pino's 2026-11-05 call), and nothing is backfilled into cards
 * (accepted proposals already have cards). The static leg pins the file as a
 * pure drop so no backfill machinery can sneak in later; the dynamic leg
 * proves a database at the head of the chain really lost both objects.
 */

const DROP_FILE = "src/db/migrations/0287_drop_zettel_proposals.sql";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

afterAll(async () => {
  await handle?.client.end();
});

suite("0287 drops the proposal seam", () => {
  it("is a pure drop: table and enum go, nothing is backfilled", () => {
    const sql = readFileSync(DROP_FILE, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?("public"\.)?"zettel_proposals"/);
    expect(sql).toMatch(/DROP\s+TYPE\s+(IF\s+EXISTS\s+)?("public"\.)?"zettel_proposal_status"/);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+\w/i);
    expect(sql).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bCOPY\b/i);
    // No CASCADE: an unexpected dependent object should fail loudly, not
    // silently vanish with the table.
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });

  it("leaves no table and no enum behind at the chain head", async () => {
    if (!handle) throw new Error("unreachable");
    const tables = await handle.client`
      select table_name::text as name from information_schema.tables
      where table_schema = 'public' and table_name = 'zettel_proposals'
    `;
    expect(tables, "zettel_proposals survived the chain; 0287 did not run").toEqual([]);
    const types = await handle.client`
      select typname::text as name from pg_type
      where typname = 'zettel_proposal_status'
    `;
    expect(types, "zettel_proposal_status survived the chain; 0287 did not run").toEqual([]);
  });
});
