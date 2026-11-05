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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
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
/*
 * The verified-email seam, faked to the session user's stored address.
 *
 * The real one asks Clerk for a verified address whenever the keys are set.
 * A test process has no Clerk session, so it returns null, acceptance is
 * refused, and the suite goes red on every machine that configures Clerk while
 * staying green in CI (no keys) - a failure that says nothing about the code.
 * The domain's rule is "the invitation's email must match the session's
 * verified email"; this mock supplies that email so the test asserts the rule.
 */
vi.mock("@/app/(workspace)/invitations/[token]/session-email", () => ({
  async sessionVerifiedEmail(auth: { userId: string }) {
    const [row] = await holder.db!.select({ email: users.email }).from(users).where(eq(users.id, auth.userId)).limit(1);
    return row?.email ?? null;
  },
}));
/*
 * Import-graph seam. settings/actions.ts imports the preferences and
 * assistant-profile domains for its OTHER actions; this suite calls only
 * createInvitationAction/revokeInvitationAction/acceptInvitationAction,
 * which touch none of them — but under vite-node the imports still evaluate
 * their whole graph (agents/queries alone pulls 170+ files: the ai SDK,
 * unpdf, pdf-lib, @vercel/blob). Mocking the unused branches shrinks this
 * file's module graph to what it exercises. The mocks throw if ever
 * reached: a call here would mean the seam is masking real behavior and
 * must be revisited, not silently absorbed.
 */
vi.mock("@/domains/identity/preferences", () => ({
  getPreferences: vi.fn(async () => {
    throw new Error("import-graph seam: preferences are not exercised by this suite");
  }),
  updatePreferences: vi.fn(async () => {
    throw new Error("import-graph seam: preferences are not exercised by this suite");
  }),
}));
vi.mock("@/domains/agents/queries", () => ({
  getDefaultProfile: vi.fn(async () => {
    throw new Error("import-graph seam: agents/queries is not exercised by this suite");
  }),
}));
vi.mock("@/domains/agents/commands", () => ({
  updateDefaultProfileBrief: vi.fn(async () => {
    throw new Error("import-graph seam: agents/commands is not exercised by this suite");
  }),
}));

import { createInvitationAction, revokeInvitationAction } from "@/app/(workspace)/settings/actions";
import { acceptInvitationAction } from "@/app/(workspace)/invitations/[token]/actions";

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

suite("invitation acceptance (spec D4)", () => {
  // The domain's authored copy crosses action-error recognition; the route's
  // longer fallback is only for non-lifecycle failures.
  const INVALID = "This invitation is not valid.";

  async function seedInvitation() {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invact-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    const created = await createInvitationAction({ email: "joiner@polymath.test", role: "member" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("seed failed");
    return { seed, created };
  }

  async function sessionUser(email: string) {
    const [user] = await holder
      .db!.insert(users)
      .values({ clerkUserId: `tw_${crypto.randomUUID()}`, email })
      .returning();
    return user;
  }

  it("accepts a pending invitation for the session's email and seats the member", async () => {
    const { seed, created } = await seedInvitation();
    const joiner = await sessionUser("joiner@polymath.test");
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };

    const result = await acceptInvitationAction(created.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaceId).toBe(seed.workspaceId);
    expect(result.role).toBe("member");
    expect(result.replayed).toBe(false);

    const [membership] = await holder
      .db!.select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, seed.workspaceId), eq(memberships.userId, joiner.id)));
    expect(membership.status).toBe("active");
    expect(membership.role).toBe("member");

    const audits = await holder.db!.select().from(auditEvents).where(eq(auditEvents.action, "invitation.accepted"));
    expect(audits).toHaveLength(1);
  });

  it("matches a stored session email case-insensitively", async () => {
    const { seed, created } = await seedInvitation();
    const joiner = await sessionUser("Joiner@Polymath.TEST"); // invitations store lowercase
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };
    const result = await acceptInvitationAction(created.token);
    expect(result.ok).toBe(true);
  });

  it("replays the same user's own acceptance without new side effects", async () => {
    const { seed, created } = await seedInvitation();
    const joiner = await sessionUser("joiner@polymath.test");
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };

    const first = await acceptInvitationAction(created.token);
    expect(first.ok).toBe(true);
    const replay = await acceptInvitationAction(created.token);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);

    const rows = await holder
      .db!.select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, seed.workspaceId), eq(memberships.userId, joiner.id)));
    expect(rows).toHaveLength(1);
    const audits = await holder.db!.select().from(auditEvents).where(eq(auditEvents.action, "invitation.accepted"));
    expect(audits).toHaveLength(1); // no second audit entry on replay
  });

  it("answers the same invalid copy for unknown, wrong-email, and revoked tokens", async () => {
    const { seed, created } = await seedInvitation();

    const joiner = await sessionUser("joiner@polymath.test");
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };

    const unknown = await acceptInvitationAction(`inv_${"0".repeat(64)}`);
    expect(unknown).toEqual({ ok: false, error: INVALID });

    const stranger = await sessionUser("stranger@polymath.test");
    authHolder.ctx = { userId: stranger.id, workspaceId: seed.workspaceId, role: "member" };
    const wrongEmail = await acceptInvitationAction(created.token);
    expect(wrongEmail).toEqual({ ok: false, error: INVALID });

    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    await revokeInvitationAction(created.invitationId);
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };
    const revoked = await acceptInvitationAction(created.token);
    expect(revoked).toEqual({ ok: false, error: INVALID });
  });
});
