import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * D09 connector foundation: the catalog is seeded by migration, account
 * aliases are unique per workspace, status transitions are version-checked
 * and audited, and the write default is explicit and singular per provider.
 * No provider is ever called.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/integrations/commands");
let queries: typeof import("@/domains/integrations/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/integrations/commands");
  queries = await import("@/domains/integrations/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function auditCount(auth: { workspaceId: string }, subjectId: string) {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
  return rows.filter((row) => row.subjectId === subjectId).length;
}

suite("connectors", () => {
  it("serves the seeded catalog and rejects unknown providers", async () => {
    const auth = await seed("conn-catalog");
    const connectors = await queries.listConnectors(auth);
    expect(connectors.length).toBeGreaterThanOrEqual(6);
    const gmail = connectors.find((c) => c.provider === "gmail");
    expect(gmail?.capabilities).toContain("send_mail");
    expect(gmail?.riskByCapability.send_mail).toBe("external_write");
    expect(gmail?.requiresApproval).toBe(true);

    await expect(commands.registerAccount(auth, { provider: "myspace", alias: "main" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("registers accounts in connecting state with unique aliases and audits them", async () => {
    const auth = await seed("conn-register");
    const account = await commands.registerAccount(auth, { provider: "gmail", alias: "work-gmail" });
    expect(account.status).toBe("connecting");
    expect(account.isDefaultForWrites).toBe(false);
    expect(await auditCount(auth, account.id)).toBe(1);

    await expect(commands.registerAccount(auth, { provider: "gmail", alias: "work-gmail" })).rejects.toMatchObject({
      code: "conflict",
    });

    const connectors = await queries.listConnectors(auth);
    expect(connectors.find((c) => c.provider === "gmail")?.accounts.map((a) => a.alias)).toEqual(["work-gmail"]);
  });

  it("transitions status only at the expected version", async () => {
    const auth = await seed("conn-status");
    const account = await commands.registerAccount(auth, { provider: "github", alias: "oss" });
    await expect(
      commands.setAccountStatus(auth, { accountId: account.id, expectedVersion: account.version + 3, status: "active" }),
    ).rejects.toMatchObject({ code: "stale_write" });

    const active = await commands.setAccountStatus(auth, {
      accountId: account.id,
      expectedVersion: account.version,
      status: "active",
      composioConnectedAccountId: "ca_test_123",
    });
    expect(active.status).toBe("active");
    expect(active.lastHealthyAt).not.toBeNull();
    expect(active.composioConnectedAccountId).toBe("ca_test_123");
    expect(await auditCount(auth, account.id)).toBe(2);
  });

  it("keeps exactly one write default per provider", async () => {
    const auth = await seed("conn-default");
    const first = await commands.registerAccount(auth, { provider: "gmail", alias: "work" });
    const second = await commands.registerAccount(auth, { provider: "gmail", alias: "personal" });

    await commands.setDefaultForWrites(auth, { accountId: first.id, expectedVersion: first.version });
    let connectors = await queries.listConnectors(auth);
    let accounts = connectors.find((c) => c.provider === "gmail")!.accounts;
    expect(accounts.find((a) => a.alias === "work")?.isDefaultForWrites).toBe(true);
    expect(accounts.filter((a) => a.isDefaultForWrites)).toHaveLength(1);

    const firstNow = accounts.find((a) => a.alias === "work")!;
    const secondNow = accounts.find((a) => a.alias === "personal")!;
    await commands.setDefaultForWrites(auth, { accountId: second.id, expectedVersion: secondNow.version });
    connectors = await queries.listConnectors(auth);
    accounts = connectors.find((c) => c.provider === "gmail")!.accounts;
    expect(accounts.find((a) => a.alias === "personal")?.isDefaultForWrites).toBe(true);
    expect(accounts.filter((a) => a.isDefaultForWrites)).toHaveLength(1);
    expect(accounts.find((a) => a.alias === "work")!.version).toBeGreaterThan(firstNow.version);
  });
});
