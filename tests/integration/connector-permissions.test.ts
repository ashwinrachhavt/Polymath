import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * setAccountAccessTier (0229 + PROVIDER_TIERS): the owner's per-connection
 * grant. The tier id must be one of the provider's offers, the write is
 * version-checked, and the audit row lands in the same transaction.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/integrations/commands");
let workspaceId: string;
let auth: AuthContext;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/integrations/commands");
  const seeded = await seedWorkspace(db, `conn-tier-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = { ...seeded, role: "owner" };
});

afterAll(async () => {
  // Cascades to external_accounts; the suite creates only this workspace.
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

async function gmailAccount(alias: string) {
  const [row] = await db
    .insert(externalAccounts)
    .values({ workspaceId, provider: "gmail", alias, status: "active" })
    .returning();
  return row;
}

async function auditCount(action: string, subjectId: string) {
  const { auditEvents } = await import("@/domains/audit/schema");
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId));
  return rows.filter((row) => row.subjectId === subjectId && row.action === action).length;
}

suite("setAccountAccessTier", () => {
  it("a fresh account sits at the lowest tier", async () => {
    const row = await gmailAccount("tier-fresh");
    expect(row.accessTier).toBe("read_only");
  });

  it("raising the tier persists and audits in the same transaction", async () => {
    const row = await gmailAccount("tier-raise");
    const updated = await commands.setAccountAccessTier(auth, {
      accountId: row.id,
      expectedVersion: row.version,
      tierId: "read_send",
    });
    expect(updated.accessTier).toBe("read_send");
    expect(updated.version).toBe(row.version + 1);
    expect(await auditCount("integration.account_tier_set", row.id)).toBe(1);
  });

  it("an unknown tier id is a ConflictError", async () => {
    const row = await gmailAccount("tier-unknown");
    await expect(
      commands.setAccountAccessTier(auth, {
        accountId: row.id,
        expectedVersion: row.version,
        tierId: "tier:ceiling",
      }),
    ).rejects.toThrow(commands.ConflictError);
  });

  it("a stale version throws StaleWriteError", async () => {
    const row = await gmailAccount("tier-stale");
    await commands.setAccountAccessTier(auth, {
      accountId: row.id,
      expectedVersion: row.version,
      tierId: "read_send",
    });
    await expect(
      commands.setAccountAccessTier(auth, {
        accountId: row.id,
        expectedVersion: row.version,
        tierId: "read_only",
      }),
    ).rejects.toThrow(commands.StaleWriteError);
  });

  it("a provider with no tiers cannot be changed", async () => {
    const [row] = await db
      .insert(externalAccounts)
      .values({ workspaceId, provider: "stripe", alias: "tier-stripe", status: "active" })
      .returning();
    await expect(
      commands.setAccountAccessTier(auth, {
        accountId: row.id,
        expectedVersion: row.version,
        tierId: "read_only",
      }),
    ).rejects.toThrow(commands.ConflictError);
  });

  it("another workspace's account is not updatable", async () => {
    const other = await seedWorkspace(db, `conn-tier-other-${Date.now()}`);
    const otherAuth = { ...other, role: "owner" as const };
    const [row] = await db
      .insert(externalAccounts)
      .values({ workspaceId: other.workspaceId, provider: "gmail", alias: "tier-foreign", status: "active" })
      .returning();
    await expect(
      commands.setAccountAccessTier(auth, {
        accountId: row.id,
        expectedVersion: row.version,
        tierId: "read_send",
      }),
    ).rejects.toThrow(commands.StaleWriteError);
    expect(await auditCount("integration.account_tier_set", row.id)).toBe(0);
    void otherAuth;
  });
});
