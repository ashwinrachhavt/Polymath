import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { apiClients, workspaces } from "@/domains/identity/schema";
import { sha256Hex } from "@/lib/hash";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The API-key lifecycle against real Postgres: mint stores only the digest,
 * the split-format token resolves to its workspace and scopes, revocation and
 * wrong secrets fail closed, and lifecycle writes land in the audit trail.
 * Skipped locally unless TEST_DATABASE_URL points at a migrated scratch DB;
 * required in CI.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

suite("API key lifecycle", () => {
  let userId: string;
  let workspaceId: string;
  let clientId: string;
  let token: string;

  beforeAll(async () => {
    holder.db = handle!.db;
    const seeded = await seedWorkspace(handle!.db, `apikeys-${Date.now()}`);
    userId = seeded.userId;
    workspaceId = seeded.workspaceId;

    const { createApiClient } = await import("@/domains/identity/machine");
    const created = await createApiClient(ownerAuth(userId, workspaceId), {
      name: "Chrome companion",
      kind: "companion",
      scopes: ["captures:read", "captures:write"],
    });
    clientId = created.client.id;
    token = created.token;
  });

  afterAll(async () => {
    if (clientId) await handle!.db.delete(apiClients).where(eq(apiClients.id, clientId));
    if (workspaceId) await handle!.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle?.client.end();
  });

  it("stores only the digest and the key id, never the secret", async () => {
    const [row] = await handle!.db.select().from(apiClients).where(eq(apiClients.id, clientId));
    const { parseApiKey } = await import("@/domains/identity/machine");
    const parsed = parseApiKey(token)!;
    expect(row.keyId).toBe(parsed.keyId);
    expect(row.tokenHash).toBe(await sha256Hex(parsed.secret));
    expect(row.tokenHash).not.toContain(parsed.secret);
  });

  it("resolves the token to its workspace, member role and scopes", async () => {
    const { resolveCompanionToken } = await import("@/domains/identity/machine");
    const result = await resolveCompanionToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.workspaceId).toBe(workspaceId);
      expect(result.client.role).toBe("member");
      expect(result.client.scopes).toEqual(["captures:read", "captures:write"]);
    }
  });

  it("stamps last_seen_at on an authenticated call", async () => {
    const [row] = await handle!.db.select().from(apiClients).where(eq(apiClients.id, clientId));
    expect(row.lastSeenAt).not.toBeNull();
  });

  it("rejects a wrong secret for a real key id", async () => {
    const { mintApiKeySecret, resolveCompanionToken } = await import("@/domains/identity/machine");
    const { parseApiKey } = await import("@/domains/identity/machine");
    const keyId = parseApiKey(token)!.keyId;
    const wrong = `axm_${keyId}.${mintApiKeySecret().secret}`;
    expect(await resolveCompanionToken(wrong)).toEqual({ ok: false, reason: "not_found" });
  });

  it("still resolves a legacy digest-only token", async () => {
    const legacySecret = `axm_${Math.random().toString(36).slice(2)}${Date.now()}`;
    const [legacy] = await handle!.db
      .insert(apiClients)
      .values({
        workspaceId,
        name: "legacy",
        kind: "companion",
        tokenHash: await sha256Hex(legacySecret),
        status: "active",
        scopes: ["captures:write"],
      })
      .returning({ id: apiClients.id });
    const { resolveCompanionToken } = await import("@/domains/identity/machine");
    const result = await resolveCompanionToken(legacySecret);
    expect(result.ok).toBe(true);
    await handle!.db.delete(apiClients).where(eq(apiClients.id, legacy.id));
  });

  it("writes audit rows for create and revoke", async () => {
    const rows = await handle!.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, clientId));
    expect(rows.map((r) => r.action)).toContain("api_client.created");
  });

  it("stops authenticating once revoked", async () => {
    const { revokeApiClient, resolveCompanionToken } = await import("@/domains/identity/machine");
    await revokeApiClient(ownerAuth(userId, workspaceId), clientId);
    expect(await resolveCompanionToken(token)).toEqual({ ok: false, reason: "not_found" });
    const rows = await handle!.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, clientId));
    expect(rows.map((r) => r.action)).toContain("api_client.revoked");
  });

  it("refuses to create a key with no valid scope", async () => {
    const { createApiClient } = await import("@/domains/identity/machine");
    await expect(
      createApiClient(ownerAuth(userId, workspaceId), { name: "nope", kind: "machine", scopes: ["drive:*"] }),
    ).rejects.toThrow(/scope/i);
  });
});
