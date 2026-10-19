import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberships, users } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-121 AC03 against a real workspace: assignment is administration
 * (member/viewer are rank-gated out), an assignee may receive only
 * capabilities the assigner holds (the delegation-authority limit - an admin
 * cannot self-escalate or delegate role.define/billing/ownership), duplicate
 * active assignments are rejected, unassignment is a versioned lifecycle
 * event, and both commands replay by idempotency key. Nothing here tests
 * enforcement - assignments are recorded intentions until a later slice.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let assignments: typeof import("@/domains/identity/assignments");
let roles: typeof import("@/domains/identity/roles");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  assignments = await import("@/domains/identity/assignments");
  roles = await import("@/domains/identity/roles");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seedMember(workspaceId: string, slug: string, role: "member" | "admin" = "member") {
  const [user] = await db.insert(users).values({ clerkUserId: `asubj_${slug}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }).returning();
  const [membership] = await db
    .insert(memberships)
    .values({ workspaceId, userId: user.id, role, status: "active" })
    .returning();
  return membership;
}

suite("role assignments", () => {
  it("assign, list, and unassign under version guard, with receipt replay", async () => {
    const seeded = await seedWorkspace(db, `assign-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const membership = await seedMember(seeded.workspaceId, "a");

    const role = await roles.defineRole(auth, {
      key: "billing_clerk",
      label: "Billing clerk",
      capabilities: ["billing.read", "person.read"],
      idempotencyKey: crypto.randomUUID(),
    });

    const key = crypto.randomUUID();
    const assigned = await assignments.assignRoleToMembership(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      idempotencyKey: key,
    });
    expect(assigned.replayed).toBe(false);

    const replay = await assignments.assignRoleToMembership(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.assignmentId).toBe(assigned.assignmentId);

    await expect(
      assignments.assignRoleToMembership(auth, {
        membershipId: membership.id,
        roleDefinitionId: role.roleDefinitionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "assignment_exists" });

    expect(await assignments.listRoleAssignments(auth, { membershipId: membership.id })).toHaveLength(1);
    expect(await assignments.listRoleAssignments(auth, { roleDefinitionId: role.roleDefinitionId })).toHaveLength(1);

    await expect(
      assignments.unassignRoleFromMembership(auth, { assignmentId: assigned.assignmentId, expectedVersion: 7, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "assignment_stale" });

    const unKey = crypto.randomUUID();
    const unassigned = await assignments.unassignRoleFromMembership(auth, { assignmentId: assigned.assignmentId, expectedVersion: 1, idempotencyKey: unKey });
    expect(unassigned.version).toBe(2);
    const unReplay = await assignments.unassignRoleFromMembership(auth, { assignmentId: assigned.assignmentId, expectedVersion: 1, idempotencyKey: unKey });
    expect(unReplay.replayed).toBe(true);

    expect(await assignments.listRoleAssignments(auth)).toEqual([]);
    expect(await assignments.listRoleAssignments(auth, { includeRevoked: true })).toHaveLength(1);

    const reassigned = await assignments.assignRoleToMembership(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reassigned.assignmentId).not.toBe(assigned.assignmentId);
  });

  it("binds the assigner's delegation authority: admin limits and self-escalation", async () => {
    const seeded = await seedWorkspace(db, `assign-del-${Date.now()}`);
    const owner = ownerAuth(seeded.userId, seeded.workspaceId);
    const adminMembership = await seedMember(seeded.workspaceId, "b", "admin");
    const admin = { userId: adminMembership.userId, workspaceId: seeded.workspaceId, role: "admin" as const };
    const member = await seedMember(seeded.workspaceId, "c");

    const clerk = await roles.defineRole(owner, {
      key: "data_entry",
      label: "Data entry",
      capabilities: ["person.read", "person.create", "person.update"],
      idempotencyKey: crypto.randomUUID(),
    });
    const superuserRole = await roles.defineRole(owner, {
      key: "junior_owner",
      label: "Junior owner",
      capabilities: ["person.read", "role.define"],
      idempotencyKey: crypto.randomUUID(),
    });

    // Within authority: an admin assigns everyday-work capabilities, even to
    // their own membership - bounded by what they already hold, so not
    // escalation.
    const selfAssign = await assignments.assignRoleToMembership(admin, {
      membershipId: adminMembership.id,
      roleDefinitionId: clerk.roleDefinitionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(selfAssign.replayed).toBe(false);

    // Outside authority: role.define sits at the owner tier; an admin cannot
    // delegate it, to themselves or anyone else.
    await expect(
      assignments.assignRoleToMembership(admin, {
        membershipId: member.id,
        roleDefinitionId: superuserRole.roleDefinitionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "outside_delegation_authority" });
    await expect(
      assignments.assignRoleToMembership(admin, {
        membershipId: adminMembership.id,
        roleDefinitionId: superuserRole.roleDefinitionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "outside_delegation_authority" });

    // The owner holds the whole catalog and is unrestricted.
    const ownerAssign = await assignments.assignRoleToMembership(owner, {
      membershipId: member.id,
      roleDefinitionId: superuserRole.roleDefinitionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(ownerAssign.replayed).toBe(false);

    // A role revised after assignment still assigns by its latest revision:
    // widen the clerk role past admin authority and the admin can no longer
    // hand it out, though the owner can.
    const clerkDef = await roles.getRoleDefinition(owner, clerk.roleDefinitionId);
    await roles.reviseRole(owner, {
      roleDefinitionId: clerk.roleDefinitionId,
      expectedVersion: clerkDef!.definition.version,
      capabilities: ["person.read", "billing.manage"],
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      assignments.assignRoleToMembership(admin, {
        membershipId: member.id,
        roleDefinitionId: clerk.roleDefinitionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "outside_delegation_authority" });
  });

  it("rank-gates members and viewers out of assignment administration", async () => {
    const seeded = await seedWorkspace(db, `assign-rank-${Date.now()}`);
    const memberCtx = { userId: seeded.userId, workspaceId: seeded.workspaceId, role: "member" as const };
    await expect(
      assignments.assignRoleToMembership(memberCtx, { membershipId: crypto.randomUUID(), roleDefinitionId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    await expect(assignments.listRoleAssignments(memberCtx)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("rejects foreign and suspended subjects and foreign roles", async () => {
    const mine = await seedWorkspace(db, `assign-mine-${Date.now()}`);
    const other = await seedWorkspace(db, `assign-other-${Date.now()}`);
    const auth = ownerAuth(mine.userId, mine.workspaceId);
    const otherAuth = ownerAuth(other.userId, other.workspaceId);

    const foreignRole = await roles.defineRole(otherAuth, {
      key: "foreign_role",
      label: "Foreign",
      capabilities: ["person.read"],
      idempotencyKey: crypto.randomUUID(),
    });
    const membership = await seedMember(mine.workspaceId, "d");
    await expect(
      assignments.assignRoleToMembership(auth, {
        membershipId: membership.id,
        roleDefinitionId: foreignRole.roleDefinitionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "role_not_found" });

    const [suspended] = await db
      .insert(memberships)
      .values({ workspaceId: mine.workspaceId, userId: (await db.insert(users).values({ clerkUserId: `susp_${Date.now()}` }).returning())[0].id, role: "member", status: "suspended" })
      .returning();
    const role = await roles.defineRole(auth, {
      key: "reader",
      label: "Reader",
      capabilities: ["person.read"],
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      assignments.assignRoleToMembership(auth, {
        membershipId: suspended.id,
        roleDefinitionId: role.roleDefinitionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "subject_not_found" });
  });
});
