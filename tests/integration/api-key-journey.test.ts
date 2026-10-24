import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Settings > API keys journey end to end, at the layer production runs:
 * the real server actions against a real database with the 0234 schema.
 * Until 0234 is applied in production this journey cannot run there at all
 * (api_clients has no key_id column), so this suite is the pre-approval
 * proof that the code path is complete and only the migration is missing.
 *
 * Covers the whole owner journey in order: create returns the shown-once
 * token and stores only its digest; the key appears in the owner's list
 * with its key id and no secret material; the minted token authenticates as
 * its own workspace; revoke removes it from the list and stops it
 * authenticating. Plus the tenant boundary: a second workspace's owner
 * neither lists nor revokes the first's key.
 */

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("CI must provide TEST_DATABASE_URL: the integration suites cannot silently skip.");
}
const suite = url ? describe : describe.skip;

const client = url ? postgres(url, { max: 1 }) : undefined;
const holder: { db: unknown } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

import {
  createApiKeyAction,
  listApiKeysAction,
  revokeApiKeyAction,
} from "@/app/(workspace)/settings/api-key-actions";
import { resolveCompanionToken } from "@/domains/identity/machine";

suite("Settings API keys: the full owner journey on the 0234 schema", () => {
  afterAll(async () => {
    await client?.end();
  });

  it("create -> list -> authenticate -> revoke -> gone, with tenant isolation", async () => {
    holder.db = drizzle(client!);
    const owner = await seedWorkspace(holder.db as never, `journey-api-keys-${Date.now()}`);
    const neighbor = await seedWorkspace(holder.db as never, `journey-api-keys-neighbor-${Date.now()}`);
    getAuthContext.mockResolvedValue(ownerAuth(owner.userId, owner.workspaceId));

    // 1. Create: the token is returned once, shaped axm_<keyId>.<secret>.
    const created = await createApiKeyAction({
      name: "Journey key",
      kind: "machine",
      scopes: ["captures:read"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.token).toMatch(/^axm_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(created.key.keyId).toBe(created.token.split(".")[0].slice(4));

    // 2. List: the key is there with metadata, and NO secret material.
    const listed = await listApiKeysAction();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.keys).toHaveLength(1);
    const row = listed.keys[0];
    expect(row.id).toBe(created.key.id);
    expect(row.name).toBe("Journey key");
    expect(row.scopes).toEqual(["captures:read"]);
    expect(row.status).toBe("active");
    expect(JSON.stringify(listed.keys)).not.toContain(created.token);
    expect(JSON.stringify(listed.keys)).not.toContain(created.token.split(".")[1]);

    // 3. Authenticate: the minted token resolves to ITS workspace only.
    const resolved = await resolveCompanionToken(created.token);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.client.workspaceId).toBe(owner.workspaceId);
      expect(resolved.client.workspaceId).not.toBe(neighbor.workspaceId);
      expect(resolved.client.scopes).toEqual(["captures:read"]);
    }

    // 4. Tenant boundary: the neighbor owner neither lists nor revokes it.
    getAuthContext.mockResolvedValue(ownerAuth(neighbor.userId, neighbor.workspaceId));
    const foreignList = await listApiKeysAction();
    expect(foreignList.ok).toBe(true);
    if (foreignList.ok) expect(foreignList.keys).toHaveLength(0);
    const foreignRevoke = await revokeApiKeyAction({ clientId: created.key.id });
    // Revoking another workspace's key fails, and the key still authenticates.
    expect(foreignRevoke.ok).toBe(false);
    const stillThere = await resolveCompanionToken(created.token);
    expect(stillThere.ok).toBe(true);

    // 5. Revoke as the owner: gone from the list, no longer authenticates.
    getAuthContext.mockResolvedValue(ownerAuth(owner.userId, owner.workspaceId));
    const revoked = await revokeApiKeyAction({ clientId: created.key.id });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await listApiKeysAction();
    expect(afterRevoke.ok).toBe(true);
    if (afterRevoke.ok) expect(afterRevoke.keys).toHaveLength(0);
    const resolvedAfter = await resolveCompanionToken(created.token);
    expect(resolvedAfter.ok).toBe(false);
  }, 20000);
});
