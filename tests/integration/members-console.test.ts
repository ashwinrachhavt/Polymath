import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "@/domains/identity/resolve";
import { memberships, users } from "@/domains/identity/schema";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * D5 against real Postgres: the rank matrix the working Access console rides
 * on — admins manage non-owner rows, members only leave, owner rows answer
 * to owners — the reads behind it, and the last-active-owner invariant's
 * interaction with the new self-service path.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let lifecycle: typeof import("@/domains/identity/invitations");
let members: typeof import("@/domains/identity/members");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  [lifecycle, members] = await Promise.all([
    import("@/domains/identity/invitations"),
    import("@/domains/identity/members"),
  ]);
});

afterAll(async () => {
  await handle?.client.end();
});

type Role = "owner" | "admin" | "member" | "viewer";

function authOf(subject: { userId: string; workspaceId: string }, role: Role): AuthContext {
  return { userId: subject.userId, workspaceId: subject.workspaceId, role };
}

async function addMember(workspaceId: string, tag: string, role: Role): Promise<{ id: string; userId: string }> {
  const [u] = await db
    .insert(users)
    .values({ clerkUserId: `mc_${tag}_${crypto.randomUUID()}` })
    .returning();
  const [m] = await db
    .insert(memberships)
    .values({ workspaceId, userId: u.id, role, status: "active" })
    .returning({ id: memberships.id, userId: memberships.userId });
  return m;
}

async function ownerRowOf(seeded: { userId: string; workspaceId: string }) {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, seeded.workspaceId), eq(memberships.userId, seeded.userId)));
  return row;
}

suite("members console", () => {
  it("an admin changes a member's role and it persists with an audit trail", async () => {
    const seeded = await seedWorkspace(db, `mc-${Date.now()}`);
    const admin = await addMember(seeded.workspaceId, "a", "admin");
    const member = await addMember(seeded.workspaceId, "m", "member");
    const adminAuth = authOf({ userId: admin.userId, workspaceId: seeded.workspaceId }, "admin");
    const [before] = await db.select().from(memberships).where(eq(memberships.id, member.id));

    const changed = await lifecycle.changeMembership(adminAuth, { membershipId: member.id, role: "admin" });
    expect(changed).toMatchObject({ status: "active", role: "admin" });

    const [row] = await db.select().from(memberships).where(eq(memberships.id, member.id));
    expect(row.role).toBe("admin");
    expect(row.version).toBe(before.version + 1);
    expect(row.updatedBy).toBe(admin.userId);

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, member.id));
    expect(audits.some((a) => a.action === "membership.changed")).toBe(true);
  });

  it("an admin removes a member: the row stays, the status says removed", async () => {
    const seeded = await seedWorkspace(db, `mcr-${Date.now()}`);
    const admin = await addMember(seeded.workspaceId, "a", "admin");
    const member = await addMember(seeded.workspaceId, "m", "member");
    const adminAuth = authOf({ userId: admin.userId, workspaceId: seeded.workspaceId }, "admin");

    await expect(
      lifecycle.changeMembership(adminAuth, { membershipId: member.id, status: "removed" }),
    ).resolves.toMatchObject({ status: "removed" });

    const [row] = await db.select().from(memberships).where(eq(memberships.id, member.id));
    expect(row.status).toBe("removed");
    expect(row.role).toBe("member");
  });

  it("admins cannot manage owner rows or mint owners", async () => {
    const seeded = await seedWorkspace(db, `mco-${Date.now()}`);
    const admin = await addMember(seeded.workspaceId, "a", "admin");
    const member = await addMember(seeded.workspaceId, "m", "member");
    const adminAuth = authOf({ userId: admin.userId, workspaceId: seeded.workspaceId }, "admin");
    const owner = await ownerRowOf(seeded);

    await expect(
      lifecycle.changeMembership(adminAuth, { membershipId: owner.id, role: "member" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    await expect(
      lifecycle.changeMembership(adminAuth, { membershipId: owner.id, status: "removed" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    await expect(
      lifecycle.changeMembership(adminAuth, { membershipId: member.id, role: "owner" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });

    const [after] = await db.select().from(memberships).where(eq(memberships.id, member.id));
    expect(after.role).toBe("member");
  });

  it("a member cannot aim the leave verb at another member", async () => {
    const seeded = await seedWorkspace(db, `mcs-${Date.now()}`);
    const admin = await addMember(seeded.workspaceId, "a", "admin");
    const member = await addMember(seeded.workspaceId, "m", "member");
    const memberAuth = authOf({ userId: member.userId, workspaceId: seeded.workspaceId }, "member");

    await expect(
      lifecycle.changeMembership(memberAuth, { membershipId: admin.id, status: "removed" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("leave is self-service: members and non-sole owners can, viewers and sole owners cannot", async () => {
    const seeded = await seedWorkspace(db, `mcl-${Date.now()}`);
    const member = await addMember(seeded.workspaceId, "m", "member");
    const viewer = await addMember(seeded.workspaceId, "v", "viewer");

    // Member leaves their own row — the one self-service verb.
    const memberAuth = authOf({ userId: member.userId, workspaceId: seeded.workspaceId }, "member");
    await expect(
      lifecycle.changeMembership(memberAuth, { membershipId: member.id, status: "removed" }),
    ).resolves.toMatchObject({ status: "removed" });

    // A viewer cannot even leave (D5: self-service is member rank and up).
    const viewerAuth = authOf({ userId: viewer.userId, workspaceId: seeded.workspaceId }, "viewer");
    await expect(
      lifecycle.changeMembership(viewerAuth, { membershipId: viewer.id, status: "removed" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });

    // With a second owner present, the owner leaves and the workspace keeps an owner.
    const secondOwner = await addMember(seeded.workspaceId, "o2", "owner");
    const ownerAuth = authOf({ userId: seeded.userId, workspaceId: seeded.workspaceId }, "owner");
    const owner = await ownerRowOf(seeded);
    await expect(
      lifecycle.changeMembership(ownerAuth, { membershipId: owner.id, status: "removed" }),
    ).resolves.toMatchObject({ status: "removed" });

    // Now the second owner is sole: leaving is the last-owner refusal.
    const soleAuth = authOf({ userId: secondOwner.userId, workspaceId: seeded.workspaceId }, "owner");
    await expect(
      lifecycle.changeMembership(soleAuth, { membershipId: secondOwner.id, status: "removed" }),
    ).rejects.toMatchObject({ code: "last_owner" });
  });

  it("the directory read is member+; the invitation read stays admin-only", async () => {
    const seeded = await seedWorkspace(db, `mcv-${Date.now()}`);
    const admin = await addMember(seeded.workspaceId, "a", "admin");
    const member = await addMember(seeded.workspaceId, "m", "member");
    const viewer = await addMember(seeded.workspaceId, "v", "viewer");

    const ws = { workspaceId: seeded.workspaceId };
    // Owner + admin + member + viewer.
    await expect(members.listMembers(authOf({ userId: member.userId, ...ws }, "member"))).resolves.toHaveLength(4);
    await expect(members.listMembers(authOf({ userId: viewer.userId, ...ws }, "viewer"))).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
    await expect(members.listInvitations(authOf({ userId: member.userId, ...ws }, "member"))).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
    await expect(members.listInvitations(authOf({ userId: admin.userId, ...ws }, "admin"))).resolves.toEqual([]);
  });
});
