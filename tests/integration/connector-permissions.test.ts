import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * 0224 storage only: an account the owner connected is readable by default and
 * writable only after an explicit grant. Nothing here enforces the flags — the
 * executor reads them — so these tests prove the defaults and the round trip.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ workspaceId } = await seedWorkspace(db, `conn-perm-${Date.now()}`));
});

afterAll(async () => {
  // Cascades to external_accounts; the suite creates only this workspace.
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

async function readBack(alias: string) {
  const [row] = await db
    .select()
    .from(externalAccounts)
    .where(and(eq(externalAccounts.workspaceId, workspaceId), eq(externalAccounts.alias, alias)));
  return row;
}

suite("connector permissions", () => {
  it("a fresh account is readable and not writable", async () => {
    const [row] = await db
      .insert(externalAccounts)
      .values({ workspaceId, provider: "gmail", alias: "perm-fresh" })
      .returning();

    expect(row.allowRead).toBe(true);
    expect(row.allowWrite).toBe(false);
    expect((await readBack("perm-fresh")).allowWrite).toBe(false);
  });

  it("both flags flip and read back", async () => {
    const [row] = await db
      .insert(externalAccounts)
      .values({ workspaceId, provider: "gmail", alias: "perm-flip" })
      .returning();

    await db
      .update(externalAccounts)
      .set({ allowRead: false, allowWrite: true })
      .where(eq(externalAccounts.id, row.id));

    const flipped = await readBack("perm-flip");
    expect(flipped.allowRead).toBe(false);
    expect(flipped.allowWrite).toBe(true);

    await db
      .update(externalAccounts)
      .set({ allowRead: true, allowWrite: false })
      .where(eq(externalAccounts.id, row.id));

    const restored = await readBack("perm-flip");
    expect(restored.allowRead).toBe(true);
    expect(restored.allowWrite).toBe(false);
  });

  it("an insert naming neither column gets the defaults", async () => {
    await handle!.client.unsafe(
      `insert into external_accounts (workspace_id, provider, alias) values ($1, 'notion', 'perm-raw')`,
      [workspaceId],
    );

    const row = await readBack("perm-raw");
    expect(row.allowRead).toBe(true);
    expect(row.allowWrite).toBe(false);
  });
});
