import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberships, organizations, people, users } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-121 AC04 against a real workspace: grants are owner-only, bind one
 * membership to one custom role on one person/organization row, reject
 * duplicates and cross-tenant targets, record expiry as a fact, revoke under
 * an optimistic version guard, and replay by idempotency key instead of
 * duplicating. Nothing here tests enforcement - there is none yet by design.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let grants: typeof import("@/domains/identity/grants");
let roles: typeof import("@/domains/identity/roles");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  grants = await import("@/domains/identity/grants");
  roles = await import("@/domains/identity/roles");
});

afterAll(async () => {
  await handle?.client.end();
});

/** A second active membership to act as the grant subject, and a person to target. */
async function seedSubjectAndTarget(workspaceId: string, slug: string) {
  const [subjectUser] = await db.insert(users).values({ clerkUserId: `subj_${slug}_${Date.now()}` }).returning();
  const [membership] = await db
    .insert(memberships)
    .values({ workspaceId, userId: subjectUser.id, role: "member", status: "active" })
    .returning();
  const [person] = await db
    .insert(people)
    .values({ workspaceId, displayName: `Target ${slug}` })
    .returning();
  return { membership, person };
}

suite("resource grants", () => {
  it("grant, list, and revoke under version guard, with receipt replay", async () => {
    const seeded = await seedWorkspace(db, `grants-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const { membership, person } = await seedSubjectAndTarget(seeded.workspaceId, "a");

    const role = await roles.defineRole(auth, {
      key: "dossier_reviewer",
      label: "Dossier reviewer",
      capabilities: ["person.read", "document.read"],
      idempotencyKey: crypto.randomUUID(),
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const key = crypto.randomUUID();
    const granted = await grants.grantResourceRole(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      targetKind: "person",
      targetId: person.id,
      expiresAt,
      idempotencyKey: key,
    });
    expect(granted.replayed).toBe(false);

    // Same idempotency key replays the receipt; no duplicate row, no error.
    const replayed = await grants.grantResourceRole(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      targetKind: "person",
      targetId: person.id,
      expiresAt,
      idempotencyKey: key,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.grantId).toBe(granted.grantId);

    // A genuine duplicate (new key, same tuple) is rejected by the state guard.
    await expect(
      grants.grantResourceRole(auth, {
        membershipId: membership.id,
        roleDefinitionId: role.roleDefinitionId,
        targetKind: "person",
        targetId: person.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "grant_exists" });

    const listed = await grants.listResourceGrants(auth, { membershipId: membership.id });
    expect(listed.map((g) => g.id)).toEqual([granted.grantId]);
    expect(listed[0].expiresAt?.getTime()).toBe(expiresAt.getTime());

    // Stale version refuses; current version revokes; a second revoke replays.
    await expect(
      grants.revokeResourceGrant(auth, { grantId: granted.grantId, expectedVersion: 99, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "grant_stale" });

    const revokeKey = crypto.randomUUID();
    const revoked = await grants.revokeResourceGrant(auth, { grantId: granted.grantId, expectedVersion: 1, idempotencyKey: revokeKey });
    expect(revoked.version).toBe(2);
    const revokeReplay = await grants.revokeResourceGrant(auth, { grantId: granted.grantId, expectedVersion: 1, idempotencyKey: revokeKey });
    expect(revokeReplay.replayed).toBe(true);

    // Revoked rows are history: hidden by default, visible on request.
    expect(await grants.listResourceGrants(auth)).toEqual([]);
    expect(await grants.listResourceGrants(auth, { includeRevoked: true })).toHaveLength(1);

    // After revocation the same tuple can be granted fresh.
    const regranted = await grants.grantResourceRole(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      targetKind: "person",
      targetId: person.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(regranted.grantId).not.toBe(granted.grantId);
  });

  it("rejects foreign targets, foreign roles, unknown kinds, and past expiry", async () => {
    const mine = await seedWorkspace(db, `grants-mine-${Date.now()}`);
    const other = await seedWorkspace(db, `grants-other-${Date.now()}`);
    const auth = ownerAuth(mine.userId, mine.workspaceId);
    const { membership } = await seedSubjectAndTarget(mine.workspaceId, "b");
    const [foreignPerson] = await db.insert(people).values({ workspaceId: other.workspaceId, displayName: "Foreign" }).returning();

    const role = await roles.defineRole(auth, {
      key: "analyst",
      label: "Analyst",
      capabilities: ["person.read"],
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(
      grants.grantResourceRole(auth, {
        membershipId: membership.id,
        roleDefinitionId: role.roleDefinitionId,
        targetKind: "person",
        targetId: foreignPerson.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "target_not_found" });

    await expect(
      grants.grantResourceRole(auth, {
        membershipId: membership.id,
        roleDefinitionId: crypto.randomUUID(),
        targetKind: "person",
        targetId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "role_not_found" });

    await expect(
      grants.grantResourceRole(auth, {
        membershipId: membership.id,
        roleDefinitionId: role.roleDefinitionId,
        targetKind: "document",
        targetId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "grant_input" });

    const { person } = await seedSubjectAndTarget(mine.workspaceId, "c");
    await expect(
      grants.grantResourceRole(auth, {
        membershipId: membership.id,
        roleDefinitionId: role.roleDefinitionId,
        targetKind: "person",
        targetId: person.id,
        expiresAt: new Date(Date.now() - 1000),
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "grant_input" });

    // An organization target works the same way.
    const [org] = await db.insert(organizations).values({ workspaceId: mine.workspaceId, name: "Acme" }).returning();
    const ok = await grants.grantResourceRole(auth, {
      membershipId: membership.id,
      roleDefinitionId: role.roleDefinitionId,
      targetKind: "organization",
      targetId: org.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(ok.replayed).toBe(false);
  });

  it("is owner-only at the domain boundary", async () => {
    const seeded = await seedWorkspace(db, `grants-admin-${Date.now()}`);
    const admin = { userId: seeded.userId, workspaceId: seeded.workspaceId, role: "admin" as const };
    await expect(
      grants.grantResourceRole(admin, {
        membershipId: crypto.randomUUID(),
        roleDefinitionId: crypto.randomUUID(),
        targetKind: "person",
        targetId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    await expect(grants.listResourceGrants(admin)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});
