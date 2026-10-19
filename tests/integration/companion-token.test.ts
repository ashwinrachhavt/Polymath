import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiClients } from "@/domains/identity/schema";
import { sha256Hex } from "@/lib/hash";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The companion bearer invariant that needs real Postgres: the secret is never
 * stored, only its digest, and a revoked client stops authenticating. Skipped
 * unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

suite("companion bearer tokens", () => {
  let workspaceId: string;
  let clientId: string;
  const secret = `axm_${Math.random().toString(36).slice(2)}${Date.now()}`;

  beforeAll(async () => {
    holder.db = handle!.db;
    const seeded = await seedWorkspace(handle!.db, "companion");
    workspaceId = seeded.workspaceId;
    const [client] = await handle!.db
      .insert(apiClients)
      .values({
        workspaceId,
        name: "Chrome companion",
        kind: "companion",
        tokenHash: await sha256Hex(secret),
        status: "active",
      })
      .returning({ id: apiClients.id });
    clientId = client.id;
  });

  afterAll(async () => {
    if (clientId) await handle!.db.delete(apiClients).where(eq(apiClients.id, clientId));
    await handle?.client.end();
  });

  it("stores only the digest, never the secret", async () => {
    const [row] = await handle!.db.select().from(apiClients).where(eq(apiClients.id, clientId));
    expect(row.tokenHash).not.toContain(secret);
    expect(row.tokenHash).toBe(await sha256Hex(secret));
  });

  it("resolves the right workspace from the secret", async () => {
    const { resolveCompanionToken } = await import("@/domains/identity/machine");
    const result = await resolveCompanionToken(secret);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.client.workspaceId).toBe(workspaceId);
  });

  it("rejects an unknown secret", async () => {
    const { resolveCompanionToken } = await import("@/domains/identity/machine");
    const result = await resolveCompanionToken(`${secret}-wrong`);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("stops authenticating once revoked", async () => {
    await handle!.db.update(apiClients).set({ status: "revoked" }).where(eq(apiClients.id, clientId));
    const { resolveCompanionToken } = await import("@/domains/identity/machine");
    const result = await resolveCompanionToken(secret);
    expect(result).toEqual({ ok: false, reason: "not_active" });
  });
});
