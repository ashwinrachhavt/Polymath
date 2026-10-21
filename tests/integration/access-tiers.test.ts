import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * 0229 access tiers: the catalog carries per-connector tier offers (the
 * capability lists are the enforcement source, this column is what the UI
 * reads) and every pre-existing account backfills to read_only. Migrations
 * are applied by the harness (psql over src/db/migrations/*.sql), so these
 * tests only read the columns' end state.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ workspaceId } = await seedWorkspace(db, `access-tiers-${Date.now()}`));
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

async function catalogTiers(provider: string) {
  const [row] = await handle!.client.unsafe<{ access_tiers: unknown[] }[]>(
    `select access_tiers from integration_catalog where provider = $1`,
    [provider],
  );
  return row?.access_tiers;
}

suite("access tiers", () => {
  it("gmail catalog row has two tiers, lowest first", async () => {
    const tiers = (await catalogTiers("gmail")) as { id: string; capabilities: string[] }[];
    expect(tiers).toHaveLength(2);
    expect(tiers[0]!.id).toBe("read_only");
    expect(tiers[1]!.capabilities).toContain("gmail.send");
  });

  it("providers without shipped tools have empty tiers", async () => {
    for (const provider of ["stripe", "figma", "notion"]) {
      expect(await catalogTiers(provider), provider).toEqual([]);
    }
  });

  it("existing accounts backfill to read_only", async () => {
    await handle!.client.unsafe(
      `insert into external_accounts (workspace_id, provider, alias) values ($1, 'gmail', 'tier-backfill')`,
      [workspaceId],
    );

    const [row] = await handle!.client.unsafe<{ access_tier: string }[]>(
      `select access_tier from external_accounts where workspace_id = $1 and alias = 'tier-backfill'`,
      [workspaceId],
    );
    expect(row!.access_tier).toBe("read_only");
  });
});
