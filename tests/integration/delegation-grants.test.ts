import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentDelegationGrants } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-122 GA02 + GA07 against a real workspace: grants issue only to active
 * principals from an active delegator membership, expire and cap their
 * lifetime, refuse never-delegable and not-held capabilities, attenuate
 * strictly down a delegation chain, freeze their content at the database,
 * revoke one-way, and replay by idempotency key. Nothing here tests
 * request-path enforcement - the gateway slice is the first reader.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let delegation: typeof import("@/domains/agents/delegation");
let principals: typeof import("@/domains/agents/principals");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  delegation = await import("@/domains/agents/delegation");
  principals = await import("@/domains/agents/principals");
});

afterAll(async () => {
  await handle?.client.end();
});

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

async function seedPrincipal(auth: { userId: string; workspaceId: string; role: "owner" }, key: string) {
  const { principalId } = await principals.registerAgentPrincipal(auth, { key, kind: "agent", label: key });
  return principalId;
}

suite("delegation grants", () => {
  it("service principals may hold grants up to 30 days; agents stay at 7", async () => {
    const seeded = await seedWorkspace(db, `dlg-svc-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const { principalId: svc } = await principals.registerAgentPrincipal(auth, { key: "nightly", kind: "service_principal", label: "nightly" });
    const agent = await seedPrincipal(auth, "alfred_two");
    const scope = { operations: ["document.read"] };
    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: svc, scope, expiresAt: new Date(Date.now() + 29 * DAY) }),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: svc, scope, expiresAt: new Date(Date.now() + 31 * DAY) }),
    ).rejects.toMatchObject({ code: "grant_input" });
    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: agent, scope, expiresAt: new Date(Date.now() + 8 * DAY) }),
    ).rejects.toMatchObject({ code: "grant_input" });
  });

  it("issue, list, revoke one-way - with receipt replay and a pinned content hash", async () => {
    const seeded = await seedWorkspace(db, `dlg-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const principalId = await seedPrincipal(auth, "alfred");

    const key = crypto.randomUUID();
    const input = {
      agentPrincipalId: principalId,
      scope: { operations: ["document.read", "person.read"], accounts: ["work-gmail"] },
      expiresAt: new Date(Date.now() + DAY),
      idempotencyKey: key,
    };
    const issued = await delegation.issueDelegationGrant(auth, input);
    expect(issued.replayed).toBe(false);
    expect(issued.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await delegation.issueDelegationGrant(auth, input)).toEqual({ ...issued, replayed: true });

    const listed = await delegation.listDelegationGrants(auth, { agentPrincipalId: principalId });
    expect(listed).toHaveLength(1);
    expect(listed[0].delegationDepth).toBe(0);
    expect(listed[0].allowedOperations).toEqual(["document.read", "person.read"]);

    const revoked = await delegation.revokeDelegationGrant(auth, { grantId: issued.grantId, expectedVersion: 1 });
    expect(revoked.version).toBe(2);
    await expect(
      delegation.revokeDelegationGrant(auth, { grantId: issued.grantId, expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: "grant_revoked" });
    // Revoked grants leave the active listing but stay for audit.
    expect(await delegation.listDelegationGrants(auth)).toHaveLength(0);
    expect(await delegation.listDelegationGrants(auth, { includeRevoked: true })).toHaveLength(1);
  });

  it("refuses the GA01 never-delegable set and anything the delegator does not hold", async () => {
    const seeded = await seedWorkspace(db, `dlg2-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const principalId = await seedPrincipal(auth, "ops");
    const expiresAt = new Date(Date.now() + HOUR);

    for (const capability of ["action.approve", "role.define", "role.assign", "ownership.transfer"]) {
      await expect(
        delegation.issueDelegationGrant(auth, { agentPrincipalId: principalId, scope: { operations: [capability] }, expiresAt }),
      ).rejects.toMatchObject({ code: "never_delegable" });
    }
    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: principalId, scope: { operations: ["teleport"] }, expiresAt }),
    ).rejects.toMatchObject({ code: "grant_input" });

    // An admin cannot delegate role.define (owner-tier) even though it is
    // also never-delegable; member.remove is delegable in principle but the
    // admin does not hold it.
    const adminAuth = { ...auth, role: "admin" as const };
    await expect(
      delegation.issueDelegationGrant(adminAuth, { agentPrincipalId: principalId, scope: { operations: ["member.remove"] }, expiresAt }),
    ).rejects.toMatchObject({ code: "outside_delegation_authority" });
    // Members cannot issue grants at all.
    await expect(
      delegation.issueDelegationGrant({ ...auth, role: "member" as const }, { agentPrincipalId: principalId, scope: { operations: ["document.read"] }, expiresAt }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("enforces expiry rules and principal liveness", async () => {
    const seeded = await seedWorkspace(db, `dlg3-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const principalId = await seedPrincipal(auth, "research");

    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: principalId, scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toMatchObject({ code: "grant_input" });
    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: principalId, scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() + 30 * DAY) }),
    ).rejects.toMatchObject({ code: "grant_input" });

    // A suspended principal admits no new authority.
    const list = await principals.listAgentPrincipals(auth);
    await principals.setAgentPrincipalStatus(auth, { principalId: list[0].id, status: "suspended", expectedVersion: 1 });
    await expect(
      delegation.issueDelegationGrant(auth, { agentPrincipalId: principalId, scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() + HOUR) }),
    ).rejects.toMatchObject({ code: "principal_not_found" });
  });

  it("GA07: child grants attenuate strictly, depth-capped, and die with the parent", async () => {
    const seeded = await seedWorkspace(db, `dlg4-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const parent = await seedPrincipal(auth, "alfred");
    const child = await seedPrincipal(auth, "ops");

    const root = await delegation.issueDelegationGrant(auth, {
      agentPrincipalId: parent,
      scope: { operations: ["document.read", "person.read"], accounts: ["work-gmail"] },
      expiresAt: new Date(Date.now() + DAY),
    });

    // A valid child: subset operations, shorter expiry, depth 1.
    const kid = await delegation.issueDelegationGrant(auth, {
      agentPrincipalId: child,
      parentGrantId: root.grantId,
      scope: { operations: ["document.read"], accounts: ["work-gmail"] },
      expiresAt: new Date(Date.now() + HOUR),
    });
    const [kidRow] = await db.select().from(agentDelegationGrants).where(eq(agentDelegationGrants.id, kid.grantId));
    expect(kidRow.delegationDepth).toBe(1);

    // Widening operations, accounts, or expiry past the parent all fail.
    await expect(
      delegation.issueDelegationGrant(auth, {
        agentPrincipalId: child, parentGrantId: root.grantId,
        scope: { operations: ["document.update"] }, expiresAt: new Date(Date.now() + HOUR),
      }),
    ).rejects.toMatchObject({ code: "not_attenuated" });
    await expect(
      delegation.issueDelegationGrant(auth, {
        agentPrincipalId: child, parentGrantId: root.grantId,
        scope: { operations: ["document.read"], accounts: ["personal-gmail"] }, expiresAt: new Date(Date.now() + HOUR),
      }),
    ).rejects.toMatchObject({ code: "not_attenuated" });
    await expect(
      delegation.issueDelegationGrant(auth, {
        agentPrincipalId: child, parentGrantId: root.grantId,
        scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() + 2 * DAY),
      }),
    ).rejects.toMatchObject({ code: "not_attenuated" });

    // Depth cap: 1 -> 2 -> 3 -> refused.
    let parentGrantId = kid.grantId;
    for (const depth of [2, 3]) {
      const next = await delegation.issueDelegationGrant(auth, {
        agentPrincipalId: child, parentGrantId,
        scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() + HOUR - depth * 1000),
      });
      parentGrantId = next.grantId;
    }
    await expect(
      delegation.issueDelegationGrant(auth, {
        agentPrincipalId: child, parentGrantId,
        scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() + HOUR - 9000),
      }),
    ).rejects.toMatchObject({ code: "not_attenuated" });

    // Parent revocation kills the chain: no new child under a dead parent.
    const rootRow = await db.select().from(agentDelegationGrants).where(eq(agentDelegationGrants.id, root.grantId));
    await delegation.revokeDelegationGrant(auth, { grantId: root.grantId, expectedVersion: rootRow[0].version });
    await expect(
      delegation.issueDelegationGrant(auth, {
        agentPrincipalId: child, parentGrantId: root.grantId,
        scope: { operations: ["document.read"] }, expiresAt: new Date(Date.now() + HOUR),
      }),
    ).rejects.toMatchObject({ code: "parent_not_found" });
  });

  it("freezes grant content at the database and never crosses tenants", async () => {
    const a = await seedWorkspace(db, `dlgA-${Date.now()}`);
    const b = await seedWorkspace(db, `dlgB-${Date.now()}`);
    const authA = ownerAuth(a.userId, a.workspaceId);
    const authB = ownerAuth(b.userId, b.workspaceId);
    const principalId = await seedPrincipal(authA, "alfred");

    const issued = await delegation.issueDelegationGrant(authA, {
      agentPrincipalId: principalId,
      scope: { operations: ["document.read"] },
      expiresAt: new Date(Date.now() + DAY),
    });

    // The freeze trigger: mutating the granted ceiling is a database error.
    // Drizzle wraps the driver error ("Failed query: ..."), so assert on the
    // cause chain, not the wrapper.
    const freezeError = await db
      .update(agentDelegationGrants)
      .set({ allowedOperations: ["ownership.transfer"] })
      .where(eq(agentDelegationGrants.id, issued.grantId))
      .then(() => null, (e: unknown) => e);
    expect(String((freezeError as { cause?: unknown })?.cause ?? freezeError)).toMatch(/immutable/);

    // Cross-tenant: a foreign grant id is "not found".
    await expect(
      delegation.revokeDelegationGrant(authB, { grantId: issued.grantId, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "grant_not_found" });
    expect(await delegation.listDelegationGrants(authB)).toHaveLength(0);
  });
});
