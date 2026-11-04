import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memberships, users, workspaces } from "@/domains/identity/schema";
import { ownerAuth } from "../helpers/test-workspace";

/*
 * The resolver reads the per-device active-workspace cookie through
 * src/lib/active-workspace.ts, which wraps next/headers. Mocking the cookie
 * store (not the cookie module) keeps the module's read logic under test;
 * the name must match that module's COOKIE_NAME or the stale-cookie case
 * degrades to "no cookie" and fails loudly here.
 */
const activeWorkspace = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    set: (value: string) => {
      map.set("polymath_active_workspace", value);
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (activeWorkspace.map.has(name) ? { name, value: activeWorkspace.map.get(name) } : undefined),
  }),
}));

/*
 * The auth invariants the engineering guidelines says run against real Postgres. * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. *
 * `@/lib/db` (the Neon HTTP driver resolve.ts reads through) opens fetch * connections a localhost test database cannot serve, so it is mocked to the
 * same postgres-js client the assertions use — the policy suite's transport * swap. The swap must happen before the resolver is lazy-imported.
 * * This file inserts fresh unique clerk ids and truncates nothing, so pointing
 * TEST_DATABASE_URL at a scratch database or a Neon branch is enough; no * equality guard against DATABASE_URL is needed here.
 */ const handle = (function () {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  // src/lib/db-transaction.ts reads DATABASE_URL at module load; point it here
  // before anything lazy-imports that module.
  process.env.DATABASE_URL = url;
  const client = postgres(url, { max: 1, onnotice: () => {} });
  return { url, client, db: drizzle(client) };
})();
const suite = handle ? describe : describe.skip;
let db = handle?.db as ReturnType<typeof drizzle>;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

let resolveAuthContext: typeof import("@/domains/identity/resolve").resolveAuthContext;

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  db = handle.db;
  ({ resolveAuthContext } = await import("@/domains/identity/resolve"));
});
afterAll(async () => {
  await handle?.client.end();
});

beforeEach(() => {
  activeWorkspace.map.clear();
});

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

  // v1: suspended owner still resolves owner; revisit when memberships serve
  // more than one user. Pinned here so the decision is visible, not accidental.
  it("resolves a suspended owner as owner in v1", async () => {
    const first = await resolveAuthContext("clerk_spike_suspended_1");
    await db.update(memberships).set({ status: "suspended" }).where(eq(memberships.userId, first.userId));
    const again = await resolveAuthContext("clerk_spike_suspended_1");
    expect(again.userId).toBe(first.userId);
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(again.role).toBe("owner");
  });

  // Multi-workspace resolution (tenancy spec D1): the cookie picks among
  // memberships proved active right now; the fallbacks are deterministic.
  // Fresh unique ids per run keep the direct inserts collision-free without
  // truncating anything.
  const run = Date.now();

  it("prefers the cookie's workspace when it names an active membership", async () => {
    const provisioned = await resolveAuthContext(`clerk_spike_cookie_${run}`);
    const [studio] = await db
      .insert(workspaces)
      .values({ name: "Studio", slug: `studio-${run}`, isPersonal: false })
      .returning();
    await db
      .insert(memberships)
      .values({ workspaceId: studio.id, userId: provisioned.userId, role: "admin", status: "active" });

    activeWorkspace.set(studio.id);
    const switched = await resolveAuthContext(`clerk_spike_cookie_${run}`);
    expect(switched.workspaceId).toBe(studio.id);
    expect(switched.role).toBe("admin");
  });

  it("falls back to the personal workspace on a stale cookie", async () => {
    const provisioned = await resolveAuthContext(`clerk_spike_stale_${run}`);

    // A cookie naming a workspace the user never belonged to.
    activeWorkspace.set("00000000-0000-0000-0000-000000000000");
    const stranger = await resolveAuthContext(`clerk_spike_stale_${run}`);
    expect(stranger.workspaceId).toBe(provisioned.workspaceId);

    // A cookie naming a workspace whose membership was later suspended: the
    // stale cookie degrades to personal instead of erroring or leaking.
    const [studio] = await db
      .insert(workspaces)
      .values({ name: "Studio", slug: `stale-studio-${run}`, isPersonal: false })
      .returning();
    await db
      .insert(memberships)
      .values({ workspaceId: studio.id, userId: provisioned.userId, role: "member", status: "active" });
    activeWorkspace.set(studio.id);
    await db
      .update(memberships)
      .set({ status: "suspended" })
      .where(and(eq(memberships.workspaceId, studio.id), eq(memberships.userId, provisioned.userId)));
    const suspended = await resolveAuthContext(`clerk_spike_stale_${run}`);
    expect(suspended.workspaceId).toBe(provisioned.workspaceId);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, suspended.workspaceId));
    expect(ws.isPersonal).toBe(true);
  });

  it("falls back to the first active membership when there is no cookie and no personal workspace", async () => {
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: `clerk_spike_nocookie_${run}` })
      .returning();
    const [older] = await db
      .insert(workspaces)
      .values({ name: "First", slug: `first-${run}`, isPersonal: false })
      .returning();
    const [newer] = await db
      .insert(workspaces)
      .values({ name: "Second", slug: `second-${run}`, isPersonal: false })
      .returning();
    // Explicit createdAt values pin "first" by join time, not insertion luck.
    await db.insert(memberships).values({
      workspaceId: newer.id,
      userId: user.id,
      role: "admin",
      status: "active",
      createdAt: new Date(1_700_000_100_000),
    });
    await db.insert(memberships).values({
      workspaceId: older.id,
      userId: user.id,
      role: "member",
      status: "active",
      createdAt: new Date(1_700_000_000_000),
    });

    const ctx = await resolveAuthContext(`clerk_spike_nocookie_${run}`);
    expect(ctx.workspaceId).toBe(older.id);
    expect(ctx.role).toBe("member");
  });

  it("machine clients ignore the cookie: the api_client binding decides", async () => {
    const human = await resolveAuthContext(`clerk_spike_machine_${run}`);
    const [machineWs] = await db
      .insert(workspaces)
      .values({ name: "Machine WS", slug: `machine-${run}`, isPersonal: false })
      .returning();
    const [machineUser] = await db
      .insert(users)
      .values({ clerkUserId: `clerk_spike_machine_client_${run}` })
      .returning();
    await db
      .insert(memberships)
      .values({ workspaceId: machineWs.id, userId: machineUser.id, role: "owner", status: "active" });
    const { createApiClient, resolveCompanionToken } = await import("@/domains/identity/machine");
    const created = await createApiClient(ownerAuth(machineUser.id, machineWs.id), {
      name: "Companion",
      kind: "companion",
      scopes: ["captures:read"],
    });

    // The device's cookie points at the human's workspace; the machine token
    // is bound to a different one. Resolution must follow the binding, never
    // the cookie.
    activeWorkspace.set(human.workspaceId);
    const result = await resolveCompanionToken(created.token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.client.workspaceId).toBe(machineWs.id);
  });
});
