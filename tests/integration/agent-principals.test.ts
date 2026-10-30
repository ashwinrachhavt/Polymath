import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentPrincipals } from "@/domains/agents/schema";
import { memberships, users } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-122 GA01 against a real workspace: principals register under an
 * accountable human owner, are not memberships and hold no role, suspend and
 * reactivate under an optimistic version guard, revoke permanently, reject
 * duplicate keys and cross-tenant reads, and replay by idempotency key.
 * Nothing here tests request-path enforcement - there is none yet by design.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let principals: typeof import("@/domains/agents/principals");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  principals = await import("@/domains/agents/principals");
});

afterAll(async () => {
  await handle?.client.end();
});

async function ownerMembershipId(workspaceId: string, userId: string) {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId));
  void userId;
  return row.id;
}

suite("agent principals", () => {
  it("register, list, suspend/reactivate, and revoke permanently - with receipt replay", async () => {
    const seeded = await seedWorkspace(db, `principals-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);

    const key = crypto.randomUUID();
    const registered = await principals.registerAgentPrincipal(auth, {
      key: "polymath",
      kind: "agent",
      label: "Alfred",
      idempotencyKey: key,
    });
    expect(registered.replayed).toBe(false);
    const replay = await principals.registerAgentPrincipal(auth, {
      key: "polymath",
      kind: "agent",
      label: "Alfred",
      idempotencyKey: key,
    });
    expect(replay).toEqual({ principalId: registered.principalId, replayed: true });

    // The default owner is the caller's own active membership.
    const [row] = await db.select().from(agentPrincipals).where(eq(agentPrincipals.id, registered.principalId));
    expect(row.ownerMembershipId).toBe(await ownerMembershipId(seeded.workspaceId, seeded.userId));
    expect(row.status).toBe("active");

    const listed = await principals.listAgentPrincipals(auth);
    expect(listed.map((p) => p.key)).toContain("polymath");

    const suspended = await principals.setAgentPrincipalStatus(auth, {
      principalId: registered.principalId,
      status: "suspended",
      expectedVersion: 1,
    });
    expect(suspended.version).toBe(2);
    await principals.setAgentPrincipalStatus(auth, {
      principalId: registered.principalId,
      status: "active",
      expectedVersion: 2,
    });
    const revoked = await principals.setAgentPrincipalStatus(auth, {
      principalId: registered.principalId,
      status: "revoked",
      expectedVersion: 3,
    });
    expect(revoked.version).toBe(4);

    // Revoked is terminal: no path back.
    await expect(
      principals.setAgentPrincipalStatus(auth, { principalId: registered.principalId, status: "active", expectedVersion: 4 }),
    ).rejects.toMatchObject({ code: "principal_revoked" });
  });

  it("rejects duplicate keys, stale versions, and management by members", async () => {
    const seeded = await seedWorkspace(db, `principals2-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await principals.registerAgentPrincipal(auth, { key: "ops", kind: "service_principal", label: "Ops" });

    await expect(
      principals.registerAgentPrincipal(auth, { key: "ops", kind: "agent", label: "Ops again" }),
    ).rejects.toMatchObject({ code: "principal_key_taken" });

    const [row] = await db.select().from(agentPrincipals).where(eq(agentPrincipals.workspaceId, seeded.workspaceId));
    await expect(
      principals.setAgentPrincipalStatus(auth, { principalId: row.id, status: "suspended", expectedVersion: 99 }),
    ).rejects.toMatchObject({ code: "principal_stale" });

    // A member holds no agent.configure authority: principals stay human-managed at admin+.
    const memberAuth = { userId: seeded.userId, workspaceId: seeded.workspaceId, role: "member" as const };
    await expect(
      principals.registerAgentPrincipal(memberAuth, { key: "rogue", kind: "agent", label: "Rogue" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    await expect(principals.listAgentPrincipals(memberAuth)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("requires an active owning membership and an in-workspace profile", async () => {
    const seeded = await seedWorkspace(db, `principals3-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);

    // A second user whose membership is suspended cannot own a principal.
    const [otherUser] = await db.insert(users).values({ clerkUserId: `susp_${Date.now()}` }).returning();
    const [suspendedMembership] = await db
      .insert(memberships)
      .values({ workspaceId: seeded.workspaceId, userId: otherUser.id, role: "member", status: "suspended" })
      .returning();
    await expect(
      principals.registerAgentPrincipal(auth, {
        key: "nightly_briefing",
        kind: "service_principal",
        label: "Nightly briefing",
        ownerMembershipId: suspendedMembership.id,
      }),
    ).rejects.toMatchObject({ code: "owner_not_found" });

    await expect(
      principals.registerAgentPrincipal(auth, {
        key: "ghost",
        kind: "agent",
        label: "Ghost",
        agentProfileId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "profile_not_found" });

    // A real in-workspace profile binds cleanly.
    const [profile] = await db
      .insert(agentProfiles)
      .values({ workspaceId: seeded.workspaceId, name: `p-${Date.now()}` })
      .returning();
    const ok = await principals.registerAgentPrincipal(auth, {
      key: "researcher",
      kind: "agent",
      label: "Researcher",
      agentProfileId: profile.id,
    });
    expect(ok.principalId).toBeTruthy();
  });

  it("never reads another workspace's principals", async () => {
    const a = await seedWorkspace(db, `principalsA-${Date.now()}`);
    const b = await seedWorkspace(db, `principalsB-${Date.now()}`);
    const authA = ownerAuth(a.userId, a.workspaceId);
    const authB = ownerAuth(b.userId, b.workspaceId);

    const registered = await principals.registerAgentPrincipal(authA, { key: "polymath", kind: "agent", label: "Alfred" });
    // The same key is free in the other workspace (uniqueness is per-tenant).
    await principals.registerAgentPrincipal(authB, { key: "polymath", kind: "agent", label: "Alfred B" });

    // A foreign id is "not found", never fetched-and-rejected.
    await expect(
      principals.setAgentPrincipalStatus(authB, { principalId: registered.principalId, status: "suspended", expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "principal_not_found" });
    expect((await principals.listAgentPrincipals(authB)).map((p) => p.key)).toEqual(["polymath"]);
  });
});
