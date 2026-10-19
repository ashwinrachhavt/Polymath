import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { CAPABILITY_CATALOG_VERSION, FIXED_ROLE_CAPABILITIES, validateRoleCapabilities, type Capability } from "@/domains/identity/capabilities";
import type { AuthContext } from "@/domains/identity/resolve";
import { memberships } from "@/domains/identity/schema";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { getActiveAgentPrincipal } from "./principals";
import { agentDelegationGrants } from "./schema";

/*
 * ASH-122 GA02 + GA07: delegation grants - the ONLY path by which authority
 * reaches an agent principal. The rules, in order:
 *
 *  1. Issuance is a human act (admin+), and the delegator is a MEMBERSHIP -
 *     structurally, an agent can never mint a grant (GA01 acceptance).
 *  2. AN AGENT MAY RECEIVE ONLY CAPABILITIES THE DELEGATOR HOLDS - the same
 *     one-line delegation limit #114 shipped for role assignment, read from
 *     the fixed-role projection.
 *  3. Some capabilities are never delegable to an agent at all: approving
 *     actions (an agent must not approve its own), defining or assigning
 *     roles (self-escalation), and transferring ownership.
 *  4. Every grant expires (bounded authority has no "forever" shape) within
 *     a maximum lifetime, and its content is frozen at issuance - a DB
 *     trigger enforces immutability, and content_hash pins the canonical
 *     bytes so the gateway can detect tampering.
 *  5. GA07 attenuation: a child grant must name a parent it is a strict
 *     subset of (operations, resources, accounts, destinations, expiry), one
 *     depth level deeper, capped at depth 3 - delegation can only ever
 *     NARROW authority down a chain.
 *
 * Default off: nothing verifies grants in the request path yet; guards.ts
 * RANK remains the only enforcement surface. The GA03 gateway is the first
 * reader.
 */

export class DelegationGrantError extends Error {
  constructor(
    public readonly code:
      | "grant_input"
      | "grant_not_found"
      | "grant_stale"
      | "grant_revoked"
      | "principal_not_found"
      | "delegator_not_found"
      | "parent_not_found"
      | "outside_delegation_authority"
      | "never_delegable"
      | "not_attenuated",
    message: string,
  ) {
    super(message);
    this.name = "DelegationGrantError";
  }
}

/** GA01: capabilities an agent can never hold, whoever delegates. */
export const NEVER_DELEGABLE: readonly Capability[] = [
  "action.approve",
  "role.define",
  "role.assign",
  "ownership.transfer",
];

/** Bounded means bounded: the longest a grant may live. */
export const MAX_GRANT_LIFETIME_MS = 7 * 24 * 3600 * 1000;

export const MAX_DELEGATION_DEPTH = 3;

export type GrantScope = {
  operations: string[];
  resources?: string[];
  accounts?: string[];
  destinations?: string[];
};

/** Deterministic canonical form: sorted keys, sorted scope arrays, so one content hashes to one digest. */
export function canonicalGrantContent(input: {
  workspaceId: string;
  delegatorMembershipId: string;
  agentPrincipalId: string;
  parentGrantId: string | null;
  delegationDepth: number;
  profileRevisionId: string | null;
  contextManifestId: string | null;
  scope: GrantScope;
  catalogVersion: number;
  expiresAt: string;
}): string {
  const sorted = (list?: string[]) => (list ? [...list].sort() : null);
  return JSON.stringify({
    workspaceId: input.workspaceId,
    delegatorMembershipId: input.delegatorMembershipId,
    agentPrincipalId: input.agentPrincipalId,
    parentGrantId: input.parentGrantId,
    delegationDepth: input.delegationDepth,
    profileRevisionId: input.profileRevisionId,
    contextManifestId: input.contextManifestId,
    allowedOperations: sorted(input.scope.operations),
    allowedResources: sorted(input.scope.resources),
    allowedAccounts: sorted(input.scope.accounts),
    allowedDestinations: sorted(input.scope.destinations),
    catalogVersion: input.catalogVersion,
    expiresAt: input.expiresAt,
  });
}

function validateScope(scope: GrantScope): Capability[] {
  const result = validateRoleCapabilities(scope.operations);
  if (!result.ok) {
    throw new DelegationGrantError("grant_input", `A grant can only delegate catalog capabilities; unknown: ${result.invalid.join(", ")}.`);
  }
  const never = result.capabilities.filter((c) => NEVER_DELEGABLE.includes(c));
  if (never.length) {
    throw new DelegationGrantError("never_delegable", `An agent can never hold: ${never.join(", ")}.`);
  }
  for (const [label, list] of [["resource", scope.resources], ["account", scope.accounts], ["destination", scope.destinations]] as const) {
    if (list && list.some((v) => typeof v !== "string" || !v.trim())) {
      throw new DelegationGrantError("grant_input", `Every ${label} bound must be a non-empty string.`);
    }
  }
  return result.capabilities;
}

/** Rule 2: every delegated capability must be one the delegator holds. */
function assertWithinDelegatorAuthority(auth: AuthContext, capabilities: Capability[]) {
  const held = new Set<string>(FIXED_ROLE_CAPABILITIES[auth.role]);
  const outside = capabilities.filter((c) => !held.has(c));
  if (outside.length) {
    throw new DelegationGrantError(
      "outside_delegation_authority",
      `You cannot delegate what you do not hold: ${outside.join(", ")}.`,
    );
  }
}

type GrantRow = typeof agentDelegationGrants.$inferSelect;

/** Rule 5: the child is a subset of the parent on every axis, and one level deeper. */
function assertAttenuation(child: GrantScope & { expiresAt: Date }, parent: GrantRow, depth: number) {
  const problems: string[] = [];
  const subset = (childList: string[] | undefined, parentJson: unknown, axis: string) => {
    const parentList = (parentJson as string[] | null) ?? null;
    if (!childList) return;
    if (!parentList) {
      problems.push(`${axis}: the parent delegates no ${axis} bound, so the child cannot narrow it`);
      return;
    }
    const held = new Set(parentList);
    const extra = childList.filter((v) => !held.has(v));
    if (extra.length) problems.push(`${axis}: not in the parent grant: ${extra.join(", ")}`);
  };
  subset(child.operations, parent.allowedOperations, "operations");
  subset(child.resources, parent.allowedResources, "resources");
  subset(child.accounts, parent.allowedAccounts, "accounts");
  subset(child.destinations, parent.allowedDestinations, "destinations");
  if (child.expiresAt.getTime() > parent.expiresAt.getTime()) {
    problems.push("expiry: a child grant cannot outlive its parent");
  }
  if (depth !== parent.delegationDepth + 1) {
    problems.push(`depth: expected ${parent.delegationDepth + 1} (parent depth + 1), got ${depth}`);
  }
  if (depth > MAX_DELEGATION_DEPTH) {
    problems.push(`depth: delegation chains are capped at ${MAX_DELEGATION_DEPTH}`);
  }
  if (problems.length) {
    throw new DelegationGrantError("not_attenuated", `A child grant must attenuate its parent - ${problems.join("; ")}.`);
  }
}

async function loadActiveGrant(tx: TxDrizzle, workspaceId: string, grantId: string): Promise<GrantRow> {
  const [grant] = await tx
    .select()
    .from(agentDelegationGrants)
    .where(and(eq(agentDelegationGrants.id, grantId), eq(agentDelegationGrants.workspaceId, workspaceId)))
    .limit(1);
  if (!grant) throw new DelegationGrantError("grant_not_found", "No such grant in this workspace.");
  return grant;
}

export async function issueDelegationGrant(
  auth: AuthContext,
  input: {
    agentPrincipalId: string;
    scope: GrantScope;
    expiresAt: Date;
    parentGrantId?: string;
    profileRevisionId?: string;
    contextManifestId?: string;
    idempotencyKey?: string;
  },
) {
  requireRole(auth, "admin");
  const capabilities = validateScope(input.scope);
  assertWithinDelegatorAuthority(auth, capabilities);
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new DelegationGrantError("grant_input", "A grant needs an expiry.");
  }

  return withTransaction(async (tx) => {
    // State guards INSIDE the receipt callback, as everywhere: a replayed
    // receipt returns the stored result without re-checking state the first
    // attempt itself changed.
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "issueDelegationGrant", ...input }, async () => {
      const now = Date.now();
      if (input.expiresAt.getTime() <= now) {
        throw new DelegationGrantError("grant_input", "A grant's expiry must be in the future.");
      }
      if (input.expiresAt.getTime() > now + MAX_GRANT_LIFETIME_MS) {
        throw new DelegationGrantError("grant_input", `A grant may live at most ${MAX_GRANT_LIFETIME_MS / (24 * 3600 * 1000)} days; renewals are new grants.`);
      }
      const principal = await getActiveAgentPrincipal(tx, auth.workspaceId, input.agentPrincipalId);
      if (!principal) {
        throw new DelegationGrantError("principal_not_found", "No active principal with that id in this workspace.");
      }
      // The delegator is the caller's own active membership, resolved
      // server-side - never a client-supplied id.
      const [delegator] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, auth.workspaceId),
            eq(memberships.userId, auth.userId),
            eq(memberships.status, "active"),
          ),
        )
        .limit(1);
      if (!delegator) throw new DelegationGrantError("delegator_not_found", "You have no active membership in this workspace.");

      let parentGrantId: string | null = null;
      let delegationDepth = 0;
      if (input.parentGrantId) {
        const [parent] = await tx
          .select()
          .from(agentDelegationGrants)
          .where(and(eq(agentDelegationGrants.id, input.parentGrantId), eq(agentDelegationGrants.workspaceId, auth.workspaceId)))
          .limit(1);
        if (!parent) throw new DelegationGrantError("parent_not_found", "No parent grant with that id in this workspace.");
        if (parent.revokedAt) throw new DelegationGrantError("parent_not_found", "The parent grant is revoked; its chain is dead.");
        if (parent.expiresAt.getTime() <= now) throw new DelegationGrantError("parent_not_found", "The parent grant has expired.");
        delegationDepth = parent.delegationDepth + 1;
        assertAttenuation({ ...input.scope, expiresAt: input.expiresAt }, parent, delegationDepth);
        parentGrantId = parent.id;
      }

      const content = canonicalGrantContent({
        workspaceId: auth.workspaceId,
        delegatorMembershipId: delegator.id,
        agentPrincipalId: input.agentPrincipalId,
        parentGrantId,
        delegationDepth,
        profileRevisionId: input.profileRevisionId ?? null,
        contextManifestId: input.contextManifestId ?? null,
        scope: { operations: capabilities, resources: input.scope.resources, accounts: input.scope.accounts, destinations: input.scope.destinations },
        catalogVersion: CAPABILITY_CATALOG_VERSION,
        expiresAt: input.expiresAt.toISOString(),
      });
      const contentHash = await sha256Hex(content);

      const [grant] = await tx
        .insert(agentDelegationGrants)
        .values({
          workspaceId: auth.workspaceId,
          delegatorMembershipId: delegator.id,
          agentPrincipalId: input.agentPrincipalId,
          parentGrantId,
          delegationDepth,
          profileRevisionId: input.profileRevisionId ?? null,
          contextManifestId: input.contextManifestId ?? null,
          allowedOperations: capabilities,
          allowedResources: input.scope.resources ?? null,
          allowedAccounts: input.scope.accounts ?? null,
          allowedDestinations: input.scope.destinations ?? null,
          catalogVersion: CAPABILITY_CATALOG_VERSION,
          contentHash,
          expiresAt: input.expiresAt,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "delegation_grant.issued",
          subjectType: "agent_delegation_grant",
          subjectId: grant.id,
          summary: `Delegated ${capabilities.length} capabilities to principal "${principal.key}" until ${input.expiresAt.toISOString()}`,
          metadata: {
            principalId: input.agentPrincipalId,
            delegatorMembershipId: delegator.id,
            parentGrantId,
            delegationDepth,
            operations: capabilities,
            expiresAt: input.expiresAt.toISOString(),
            contentHash,
          },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({
        workspaceId: auth.workspaceId,
        topic: "delegation_grant.issued",
        payload: { grantId: grant.id, principalId: input.agentPrincipalId, parentGrantId, expiresAt: input.expiresAt.toISOString() },
      });
      return { grantId: grant.id, contentHash };
    });
    return { ...value, replayed };
  });
}

export async function revokeDelegationGrant(
  auth: AuthContext,
  input: { grantId: string; expectedVersion: number; idempotencyKey?: string },
) {
  requireRole(auth, "admin");
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "revokeDelegationGrant", ...input }, async () => {
      const grant = await loadActiveGrant(tx, auth.workspaceId, input.grantId);
      if (grant.revokedAt) throw new DelegationGrantError("grant_revoked", "That grant is already revoked.");
      if (grant.version !== input.expectedVersion) {
        throw new DelegationGrantError("grant_stale", `Expected version ${input.expectedVersion}, found ${grant.version}. Reload and retry.`);
      }
      await tx
        .update(agentDelegationGrants)
        .set({ revokedAt: new Date(), revokedBy: auth.userId, version: grant.version + 1, updatedBy: auth.userId, updatedAt: new Date() })
        .where(eq(agentDelegationGrants.id, grant.id));
      await recordAudit(
        auth,
        {
          action: "delegation_grant.revoked",
          subjectType: "agent_delegation_grant",
          subjectId: grant.id,
          summary: `Revoked delegation grant for principal ${grant.agentPrincipalId}`,
          metadata: { principalId: grant.agentPrincipalId, delegatorMembershipId: grant.delegatorMembershipId },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({
        workspaceId: auth.workspaceId,
        topic: "delegation_grant.revoked",
        payload: { grantId: grant.id, principalId: grant.agentPrincipalId },
      });
      return { grantId: grant.id, version: grant.version + 1 };
    });
    return { ...value, replayed };
  });
}

/** Grants for management review, active first, newest edit first. */
export async function listDelegationGrants(
  auth: AuthContext,
  filter?: { agentPrincipalId?: string; delegatorMembershipId?: string; includeRevoked?: boolean },
) {
  requireRole(auth, "admin");
  const conditions: SQL[] = [eq(agentDelegationGrants.workspaceId, auth.workspaceId)];
  if (filter?.agentPrincipalId) conditions.push(eq(agentDelegationGrants.agentPrincipalId, filter.agentPrincipalId));
  if (filter?.delegatorMembershipId) conditions.push(eq(agentDelegationGrants.delegatorMembershipId, filter.delegatorMembershipId));
  if (!filter?.includeRevoked) conditions.push(isNull(agentDelegationGrants.revokedAt));
  return db.select().from(agentDelegationGrants).where(and(...conditions)).orderBy(desc(agentDelegationGrants.updatedAt));
}

/** The GA03 gateway's read: a grant row for authorization, tenant-scoped. */
export async function getDelegationGrant(tx: TxDrizzle, workspaceId: string, grantId: string) {
  const [grant] = await tx
    .select()
    .from(agentDelegationGrants)
    .where(and(eq(agentDelegationGrants.id, grantId), eq(agentDelegationGrants.workspaceId, workspaceId)))
    .limit(1);
  return grant ?? null;
}
