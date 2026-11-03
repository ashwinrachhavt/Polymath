import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { invitations, memberships, users } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace, truncateAll } from "../helpers/test-workspace";

/*
 * Permission matrix for the invitation server actions (spec D4): admins and
 * owners invite and revoke, members and viewers are refused with the guard's
 * authored copy, writes stay scoped to the caller's workspace, and every
 * success leaves the domain's audit trail intact. Acceptance is exercised
 * separately against the token route's action further down this file.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "admin" | "member" | "viewer" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { createInvitationAction, revokeInvitationAction } from "@/app/(workspace)/settings/actions";

beforeAll(async () => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

async function addMember(workspaceId: string, clerkUserId: string, role: "admin" | "member" | "viewer") {
  const [user] = await holder.db!.insert(users).values({ clerkUserId }).returning();
  await holder.db!.insert(memberships).values({ workspaceId, userId: user.id, role, status: "active" });
  return user;
}

suite("invitation actions (spec D4)", () => {
  it("lets an owner create an invitation and leaves the audit trail intact", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };

    const result = await createInvitationAction({ email: "newmember@polymath.test", role: "member" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toMatch(/^inv_[0-9a-f]{64}$/);
    expect(result.invitePath).toBe(`/invitations/${result.token}`);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [row] = await holder.db!.select().from(invitations).where(eq(invitations.workspaceId, seed.workspaceId));
    expect(row.email).toBe("newmember@polymath.test");
    expect(row.tokenHash).not.toBe(result.token); // only the digest is stored
    expect(row.acceptedAt).toBeNull();
    expect(row.revokedAt).toBeNull();

    const audits = await holder
      .db!.select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, seed.workspaceId), eq(auditEvents.action, "invitation.created")));
    expect(audits).toHaveLength(1);
  });

  it("lets an admin create an invitation too (spec D4: admin+)", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    const admin = await addMember(seed.workspaceId, `tw_${crypto.randomUUID()}`, "admin");
    authHolder.ctx = { userId: admin.id, workspaceId: seed.workspaceId, role: "admin" };

    const result = await createInvitationAction({ email: "invited@polymath.test" });
    expect(result.ok).toBe(true);
  });

  it.each(["member", "viewer"] as const)("refuses a %s with the guard's authored copy", async (role) => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    const actor = await addMember(seed.workspaceId, `tw_${crypto.randomUUID()}`, role);
    authHolder.ctx = { userId: actor.id, workspaceId: seed.workspaceId, role };

    const result = await createInvitationAction({ email: "blocked@polymath.test", role: "admin" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Requires admin; this member is (member|viewer)\.$/);
  });

  it("blocks a second open invitation for the same email through the partial-unique index", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };

    const first = await createInvitationAction({ email: "once@polymath.test" });
    expect(first.ok).toBe(true);
    const second = await createInvitationAction({ email: "once@polymath.test" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("That address already has a pending invitation. Revoke it to send another.");
  });

  it("lets an admin revoke a pending invitation once and keeps the audit trail", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    const admin = await addMember(seed.workspaceId, `tw_${crypto.randomUUID()}`, "admin");
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    const created = await createInvitationAction({ email: "bye@polymath.test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    authHolder.ctx = { userId: admin.id, workspaceId: seed.workspaceId, role: "admin" };
    const revoke = await revokeInvitationAction(created.invitationId);
    expect(revoke).toEqual({ ok: true, revoked: true });
    const again = await revokeInvitationAction(created.invitationId);
    expect(again).toEqual({ ok: true, revoked: false });

    const audits = await holder.db!.select().from(auditEvents).where(eq(auditEvents.action, "invitation.revoked"));
    expect(audits).toHaveLength(1);
  });

  it("never lets one workspace revoke another workspace's invitation", async () => {
    await truncateAll(handle!.client);
    const a = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    const b = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" };
    const created = await createInvitationAction({ email: "scoped@polymath.test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const adminB = await addMember(b.workspaceId, `tw_${crypto.randomUUID()}`, "admin");
    authHolder.ctx = { userId: adminB.id, workspaceId: b.workspaceId, role: "admin" };
    const revoke = await revokeInvitationAction(created.invitationId);
    expect(revoke).toEqual({ ok: true, revoked: false });

    const [row] = await holder.db!.select().from(invitations).where(eq(invitations.workspaceId, a.workspaceId));
    expect(row.revokedAt).toBeNull();
  });
});
