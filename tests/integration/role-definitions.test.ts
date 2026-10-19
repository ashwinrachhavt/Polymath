import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-121 AC03 against a real workspace: definitions are owner-only, keys are
 * unique per workspace, edits append immutable catalog-validated revisions
 * under an optimistic version guard, archiving preserves history, and the
 * same idempotency key replays instead of duplicating.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let roles: typeof import("@/domains/identity/roles");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  roles = await import("@/domains/identity/roles");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("role definitions", () => {
  it("define, revise and archive under version guard, with immutable revisions", async () => {
    const seeded = await seedWorkspace(db, `roles-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);

    const defined = await roles.defineRole(auth, {
      key: "billing_clerk",
      label: "Billing clerk",
      capabilities: ["billing.read", "person.read"],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(defined.replayed).toBe(false);

    // Same key replays the receipt instead of erroring on the unique index.
    const key = crypto.randomUUID();
    const input = { key: "auditor", label: "Auditor", capabilities: ["audit.read"], idempotencyKey: key };
    const a = await roles.defineRole(auth, input);
    const b = await roles.defineRole(auth, input);
    expect(b.roleDefinitionId).toBe(a.roleDefinitionId);
    expect(b.replayed).toBe(true);

    // A different role with the same key is refused.
    await expect(roles.defineRole(auth, { key: "auditor", label: "Other", capabilities: ["audit.read"] })).rejects.toThrow('The key "auditor" is already used');
    // Invented capabilities never reach the schema.
    await expect(roles.defineRole(auth, { key: "wizard", label: "Wizard", capabilities: ["person.annihilate"] })).rejects.toThrow("unknown: person.annihilate");
    // Members cannot define roles.
    await expect(roles.defineRole({ ...auth, role: "member" }, { key: "nope", label: "Nope", capabilities: ["audit.read"] })).rejects.toThrow("Requires owner");

    // Capability revision appends and bumps the version.
    const reviseKey = crypto.randomUUID();
    const reviseInput = {
      roleDefinitionId: a.roleDefinitionId,
      expectedVersion: 1,
      capabilities: ["audit.read", "billing.read"],
      idempotencyKey: reviseKey,
    };
    const revised = await roles.reviseRole(auth, reviseInput);
    expect(revised.version).toBe(2);

    // Replaying the revision after it landed returns the stored result; it
    // must not re-check the version the first attempt itself bumped.
    const reviseReplay = await roles.reviseRole(auth, reviseInput);
    expect(reviseReplay.replayed).toBe(true);
    expect(reviseReplay.version).toBe(2);

    // Stale writers lose.
    await expect(
      roles.reviseRole(auth, { roleDefinitionId: a.roleDefinitionId, expectedVersion: 1, label: "Stale edit", idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow("Expected version 1, found 2");

    const detail = await roles.getRoleDefinition(auth, a.roleDefinitionId);
    expect(detail?.revisions).toHaveLength(2);
    expect(detail?.revisions[1].capabilities).toEqual(["audit.read", "billing.read"]);

    // Revisions are immutable at the database, not by convention.
    const { roleDefinitionRevisions } = await import("@/domains/identity/schema");
    const { eq } = await import("drizzle-orm");
    await expect(
      db.update(roleDefinitionRevisions).set({ capabilities: ["ownership.transfer"] }).where(eq(roleDefinitionRevisions.id, detail!.revisions[1].id)),
    ).rejects.toThrow(/immutable/);

    // Archiving preserves history and blocks further edits.
    const archiveKey = crypto.randomUUID();
    const archiveInput = { roleDefinitionId: a.roleDefinitionId, expectedVersion: 2, idempotencyKey: archiveKey };
    const archived = await roles.archiveRole(auth, archiveInput);
    expect(archived.version).toBe(3);
    const archiveReplay = await roles.archiveRole(auth, archiveInput);
    expect(archiveReplay.replayed).toBe(true);
    await expect(
      roles.reviseRole(auth, { roleDefinitionId: a.roleDefinitionId, expectedVersion: 3, label: "Too late", idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow("archived");
    expect((await roles.getRoleDefinition(auth, a.roleDefinitionId))?.revisions).toHaveLength(2);
    expect((await roles.listRoleDefinitions(auth)).every((d) => d.id !== a.roleDefinitionId)).toBe(true);
  });

  it("rejects a cross-workspace read", async () => {
    const one = await seedWorkspace(db, `roles-a-${Date.now()}`);
    const two = await seedWorkspace(db, `roles-b-${Date.now()}`);
    const defined = await roles.defineRole(ownerAuth(one.userId, one.workspaceId), {
      key: "clerk",
      label: "Clerk",
      capabilities: ["person.read"],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await roles.getRoleDefinition(ownerAuth(two.userId, two.workspaceId), defined.roleDefinitionId)).toBeNull();
  });
});
