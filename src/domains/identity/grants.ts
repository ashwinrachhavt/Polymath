import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import type { AuthContext } from "./resolve";
import { memberships, organizations, people, resourceGrants, roleDefinitions, type ResourceGrantTargetKind } from "./schema";

/*
 * ASH-121 AC04: resource grants. A grant says "this membership holds this
 * custom role on this one resource" - the escape hatch from workspace-wide
 * roles ADR 0002 deferred. Subjects are memberships only (guests and teams
 * are later work); targets are person or organization rows; there is no
 * inheritance between resources. Grant management is owner-only, matching
 * the catalog projection that keeps role.assign at the owner tier.
 *
 * Default off: NOTHING here feeds request authorization. guards.ts RANK is
 * still the only enforcement surface; a grant row is a recorded intention
 * until a later, flagged slice makes enforcement read it. Expiry is recorded
 * as a fact (expires_at) with no background sweeper in this slice.
 */

export class ResourceGrantError extends Error {
  constructor(
    public readonly code:
      | "grant_input"
      | "grant_not_found"
      | "grant_stale"
      | "grant_revoked"
      | "grant_exists"
      | "subject_not_found"
      | "role_not_found"
      | "target_not_found",
    message: string,
  ) {
    super(message);
    this.name = "ResourceGrantError";
  }
}

function validateTargetKind(kind: string): ResourceGrantTargetKind {
  if (kind === "person" || kind === "organization") return kind;
  throw new ResourceGrantError("grant_input", `A grant target is a person or an organization, not "${kind}".`);
}

/** The polymorphic target has no FK; existence inside the tenant is the domain layer's check. */
async function assertTargetExists(tx: TxDrizzle, auth: AuthContext, kind: ResourceGrantTargetKind, targetId: string) {
  const table = kind === "person" ? people : organizations;
  const [row] = await tx
    .select({ id: table.id, archivedAt: table.archivedAt })
    .from(table)
    .where(and(eq(table.id, targetId), eq(table.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row || row.archivedAt) {
    throw new ResourceGrantError("target_not_found", `No active ${kind} with that id in this workspace.`);
  }
}

export async function grantResourceRole(
  auth: AuthContext,
  input: {
    membershipId: string;
    roleDefinitionId: string;
    targetKind: string;
    targetId: string;
    expiresAt?: Date;
    idempotencyKey?: string;
  },
) {
  requireRole(auth, "owner");
  const targetKind = validateTargetKind(input.targetKind);

  return withTransaction(async (tx) => {
    // State guards live INSIDE the receipt callback: a replayed receipt must
    // return the stored result without re-checking state the first attempt
    // itself changed (the grant now exists, the role was archived since).
    // The expiry check is time-dependent, so it is a state guard too.
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "grantResourceRole", ...input }, async () => {
      const [membership] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!membership || membership.status !== "active") {
        throw new ResourceGrantError("subject_not_found", "No active membership with that id in this workspace.");
      }
      const [role] = await tx
        .select({ id: roleDefinitions.id, key: roleDefinitions.key, archivedAt: roleDefinitions.archivedAt })
        .from(roleDefinitions)
        .where(and(eq(roleDefinitions.id, input.roleDefinitionId), eq(roleDefinitions.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!role || role.archivedAt) {
        throw new ResourceGrantError("role_not_found", "No active role definition with that id in this workspace.");
      }
      await assertTargetExists(tx, auth, targetKind, input.targetId);
      if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
        throw new ResourceGrantError("grant_input", "A grant's expiry must be in the future.");
      }
      const [existing] = await tx
        .select({ id: resourceGrants.id })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.workspaceId, auth.workspaceId),
            eq(resourceGrants.membershipId, input.membershipId),
            eq(resourceGrants.roleDefinitionId, input.roleDefinitionId),
            eq(resourceGrants.targetKind, targetKind),
            eq(resourceGrants.targetId, input.targetId),
            isNull(resourceGrants.revokedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ResourceGrantError("grant_exists", "That membership already holds that role on that resource.");
      }
      const [grant] = await tx
        .insert(resourceGrants)
        .values({
          workspaceId: auth.workspaceId,
          membershipId: input.membershipId,
          roleDefinitionId: input.roleDefinitionId,
          targetKind,
          targetId: input.targetId,
          expiresAt: input.expiresAt ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "grant.created",
          subjectType: "resource_grant",
          subjectId: grant.id,
          summary: `Granted role "${role.key}" on ${targetKind} ${input.targetId}`,
          metadata: { membershipId: input.membershipId, roleDefinitionId: input.roleDefinitionId, targetKind, targetId: input.targetId, expiresAt: input.expiresAt ?? null },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "grant.created", payload: { grantId: grant.id, membershipId: input.membershipId, targetKind, targetId: input.targetId } });
      return { grantId: grant.id };
    });
    return { ...value, replayed };
  });
}

export async function revokeResourceGrant(
  auth: AuthContext,
  input: { grantId: string; expectedVersion: number; idempotencyKey?: string },
) {
  requireRole(auth, "owner");
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "revokeResourceGrant", ...input }, async () => {
      const [grant] = await tx
        .select()
        .from(resourceGrants)
        .where(and(eq(resourceGrants.id, input.grantId), eq(resourceGrants.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!grant) throw new ResourceGrantError("grant_not_found", "No such grant in this workspace.");
      if (grant.revokedAt) throw new ResourceGrantError("grant_revoked", "That grant is already revoked.");
      if (grant.version !== input.expectedVersion) {
        throw new ResourceGrantError("grant_stale", `Expected version ${input.expectedVersion}, found ${grant.version}. Reload and retry.`);
      }
      await tx
        .update(resourceGrants)
        .set({ revokedAt: new Date(), revokedBy: auth.userId, version: grant.version + 1, updatedBy: auth.userId, updatedAt: new Date() })
        .where(eq(resourceGrants.id, grant.id));
      await recordAudit(
        auth,
        { action: "grant.revoked", subjectType: "resource_grant", subjectId: grant.id, summary: `Revoked role grant on ${grant.targetKind} ${grant.targetId}`, metadata: { membershipId: grant.membershipId, roleDefinitionId: grant.roleDefinitionId } },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "grant.revoked", payload: { grantId: grant.id } });
      return { grantId: grant.id, version: grant.version + 1 };
    });
    return { ...value, replayed };
  });
}

/** Grants for management review, active first, newest edit first. Optional filters. */
export async function listResourceGrants(
  auth: AuthContext,
  filter?: { membershipId?: string; targetKind?: ResourceGrantTargetKind; targetId?: string; includeRevoked?: boolean },
) {
  requireRole(auth, "owner");
  const conditions: SQL[] = [eq(resourceGrants.workspaceId, auth.workspaceId)];
  if (filter?.membershipId) conditions.push(eq(resourceGrants.membershipId, filter.membershipId));
  if (filter?.targetKind) conditions.push(eq(resourceGrants.targetKind, filter.targetKind));
  if (filter?.targetId) conditions.push(eq(resourceGrants.targetId, filter.targetId));
  if (!filter?.includeRevoked) conditions.push(isNull(resourceGrants.revokedAt));
  return db.select().from(resourceGrants).where(and(...conditions)).orderBy(desc(resourceGrants.updatedAt));
}
