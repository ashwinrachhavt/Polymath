import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberships, workspaces } from "@/domains/identity/schema";

/*
 * The auth invariants agents/engineering.md says run against real Postgres.
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied, and the resolver is imported lazily: src/lib/db.ts throws at module
 * load without DATABASE_URL, so a static import would fail this file instead
 * of skipping it, and take the whole suite down with it.
 */

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle>;
let resolveAuthContext: typeof import("@/domains/identity/resolve").resolveAuthContext;

beforeAll(async () => {
  if (!url) return;
  if (url === process.env.DATABASE_URL)
    throw new Error("TEST_DATABASE_URL equals DATABASE_URL; use a scratch DB or Neon branch.");
  client = postgres(url, { max: 1 });
  db = drizzle(client);
  ({ resolveAuthContext } = await import("@/domains/identity/resolve"));
});
afterAll(async () => { await client?.end(); });

suite("auth resolution", () => {
  it("auto-provisions workspace + owner membership on first sign-in", async () => {
    const ctx = await resolveAuthContext("clerk_spike_new_1");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    expect(ws.isPersonal).toBe(true);
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, ctx.userId)));
    expect(m.role).toBe("owner");
    expect(m.status).toBe("active");
  });

  it("is idempotent: second sign-in resolves the same workspace, no duplicate rows", async () => {
    const a = await resolveAuthContext("clerk_spike_idem_1");
    const b = await resolveAuthContext("clerk_spike_idem_1");
    expect(b.workspaceId).toBe(a.workspaceId);
    const all = await db.select().from(memberships).where(eq(memberships.userId, a.userId));
    expect(all).toHaveLength(1);
  });

  it("resolves role from an existing active membership", async () => {
    const ctx = await resolveAuthContext("clerk_spike_role_1");
    expect(["owner", "member"]).toContain(ctx.role);
  });
});
