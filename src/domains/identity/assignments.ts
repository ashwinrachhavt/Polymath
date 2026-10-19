import { and, desc, eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { CAPABILITY_CATALOG_VERSION, FIXED_ROLE_CAPABILITIES, type Capability } from "./capabilities";
import type { AuthContext } from "./resolve";
import { membershipRoleAssignments, memberships, roleDefinitionRevisions, roleDefinitions } from "./schema";

/*
 * ASH-121 AC03: assigning custom roles to memberships, with the delegation-
 * authority limit the acceptance criteria demand - "administrators cannot
 * self-escalate or grant outside delegation authority".
 *
 * The rule is one line and covers every rank: AN ASSIGNEE MAY RECEIVE ONLY
 * CAPABILITIES THE ASSIGNER HOLDS. The assigner's holding is the fixed-role
 * projection in capabilities.ts (guards.ts RANK remains the enforcement
 * surface, so the projection is what "holds" means until the capability
 * slice lands). An owner holds the whole catalog, so owners are
 * unrestricted; an admin can delegate everyday-work capabilities but never
 * role.define, billing.manage, or ownership.transfer; the rank gate keeps
 * members and viewers out of administration entirely. Self-assignment is
 * allowed but bounded by the same subset - it can never widen what the
 * assigner already has, so it is not escalation.
 *
 * Default off: nothing reads assignments for authorization yet. This module
 * records who SHOULD hold what; adoption is a later, flagged slice.
 */

export class RoleAssignmentError extends Error {
  constructor(
    public readonly code:
      | "assignment_input"
      | "assignment_not_found"
      | "assignment_stale"
      | "assignment_revoked"
      | "assignment_exists"
      | "subject_not_found"
      | "role_not_found"
      | "outside_delegation_authority",
    message: string,
  ) {
    super(message);
    this.name = "RoleAssignmentError";
  }
}

/** The role's current capabilities, read from its latest immutable revision. */
async function currentCapabilities(tx: TxDrizzle, roleDefinitionId: string): Promise<Capability[]> {
  const revisions = await tx
    .select({ revision: roleDefinitionRevisions.revision, capabilities: roleDefinitionRevisions.capabilities })
    .from(roleDefinitionRevisions)
    .where(eq(roleDefinitionRevisions.roleDefinitionId, roleDefinitionId))
    .orderBy(desc(roleDefinitionRevisions.revision))
    .limit(1);
  return (revisions[0]?.capabilities ?? []) as Capability[];
}

export async function assignRoleToMembership(
  auth: AuthContext,
  input: { membershipId: string; roleDefinitionId: string; idempotencyKey?: string },
) {
  requireRole(auth, "admin");
  const held = new Set<string>(FIXED_ROLE_CAPABILITIES[auth.role]);

  return withTransaction(async (tx) => {
    // State guards live INSIDE the receipt callback: a replayed receipt must
    // return the stored result without re-checking state the first attempt
    // itself changed (the assignment now exists, the role was revised or
    // archived since).
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "assignRoleToMembership", ...input }, async () => {
      const [membership] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!membership || membership.status !== "active") {
        throw new RoleAssignmentError("subject_not_found", "No active membership with that id in this workspace.");
      }
      const [role] = await tx
        .select({ id: roleDefinitions.id, key: roleDefinitions.key, archivedAt: roleDefinitions.archivedAt })
        .from(roleDefinitions)
        .where(and(eq(roleDefinitions.id, input.roleDefinitionId), eq(roleDefinitions.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!role || role.archivedAt) {
        throw new RoleAssignmentError("role_not_found", "No active role definition with that id in this workspace.");
      }
      // The delegation limit: the assigner must hold every capability the
      // role confers. Read from the latest revision so a role edited since
      // the assigner loaded it cannot smuggle new authority into the
      // assignment.
      const capabilities = await currentCapabilities(tx, role.id);
      const outside = capabilities.filter((c) => !held.has(c));
      if (outside.length) {
        throw new RoleAssignmentError(
          "outside_delegation_authority",
          `A ${auth.role} cannot assign a role granting: ${outside.join(", ")}.`,
        );
      }
      const [existing] = await tx
        .select({ id: membershipRoleAssignments.id })
        .from(membershipRoleAssignments)
        .where(
          and(
            eq(membershipRoleAssignments.workspaceId, auth.workspaceId),
            eq(membershipRoleAssignments.membershipId, input.membershipId),
            eq(membershipRoleAssignments.roleDefinitionId, input.roleDefinitionId),
            isNull(membershipRoleAssignments.revokedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new RoleAssignmentError("assignment_exists", "That membership already holds that role.");
      }
      const [assignment] = await tx
        .insert(membershipRoleAssignments)
        .values({
          workspaceId: auth.workspaceId,
          membershipId: input.membershipId,
          roleDefinitionId: input.roleDefinitionId,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "role.assigned",
          subjectType: "membership_role_assignment",
          subjectId: assignment.id,
          summary: `Assigned role "${role.key}" to membership ${input.membershipId}`,
          metadata: { membershipId: input.membershipId, roleDefinitionId: input.roleDefinitionId, capabilities, catalogVersion: CAPABILITY_CATALOG_VERSION },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "role.assigned", payload: { assignmentId: assignment.id, membershipId: input.membershipId, roleDefinitionId: input.roleDefinitionId } });
      return { assignmentId: assignment.id };
    });
    return { ...value, replayed };
  });
}

export async function unassignRoleFromMembership(
  auth: AuthContext,
  input: { assignmentId: string; expectedVersion: number; idempotencyKey?: string },
) {
  requireRole(auth, "admin");
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "unassignRoleFromMembership", ...input }, async () => {
      const [assignment] = await tx
        .select()
        .from(membershipRoleAssignments)
        .where(and(eq(membershipRoleAssignments.id, input.assignmentId), eq(membershipRoleAssignments.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!assignment) throw new RoleAssignmentError("assignment_not_found", "No such assignment in this workspace.");
      if (assignment.revokedAt) throw new RoleAssignmentError("assignment_revoked", "That assignment is already revoked.");
      if (assignment.version !== input.expectedVersion) {
        throw new RoleAssignmentError("assignment_stale", `Expected version ${input.expectedVersion}, found ${assignment.version}. Reload and retry.`);
      }
      await tx
        .update(membershipRoleAssignments)
        .set({ revokedAt: new Date(), revokedBy: auth.userId, version: assignment.version + 1, updatedBy: auth.userId, updatedAt: new Date() })
        .where(eq(membershipRoleAssignments.id, assignment.id));
      await recordAudit(
        auth,
        { action: "role.unassigned", subjectType: "membership_role_assignment", subjectId: assignment.id, summary: `Revoked role assignment for membership ${assignment.membershipId}`, metadata: { membershipId: assignment.membershipId, roleDefinitionId: assignment.roleDefinitionId } },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "role.unassigned", payload: { assignmentId: assignment.id } });
      return { assignmentId: assignment.id, version: assignment.version + 1 };
    });
    return { ...value, replayed };
  });
}

/** Active assignments, optionally for one membership or one role, newest first. */
export async function listRoleAssignments(auth: AuthContext, filter?: { membershipId?: string; roleDefinitionId?: string; includeRevoked?: boolean }) {
  requireRole(auth, "admin");
  const conditions = [eq(membershipRoleAssignments.workspaceId, auth.workspaceId)];
  if (filter?.membershipId) conditions.push(eq(membershipRoleAssignments.membershipId, filter.membershipId));
  if (filter?.roleDefinitionId) conditions.push(eq(membershipRoleAssignments.roleDefinitionId, filter.roleDefinitionId));
  if (!filter?.includeRevoked) conditions.push(isNull(membershipRoleAssignments.revokedAt));
  return db.select().from(membershipRoleAssignments).where(and(...conditions)).orderBy(desc(membershipRoleAssignments.updatedAt));
}
