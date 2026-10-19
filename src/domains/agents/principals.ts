import { and, desc, eq, type SQL } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { memberships } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { agentPrincipalStatus, agentPrincipals, agentProfiles } from "./schema";

/*
 * ASH-122 GA01: agent and service principals. A principal is the identity an
 * agent run acts under; it is NOT a person, NOT a membership, and holds no
 * role and no implicit authority (ADR 0002: membership is the only source of
 * authorization, and principals have none). Authority reaches a principal
 * only through a delegation grant minted by a human membership.
 *
 * Structural rules this module enforces:
 *  - management is a human act: registering, suspending and revoking require
 *    an admin-or-owner AuthContext (the catalog projection seats
 *    agent.configure at the admin tier). A principal can never manage itself,
 *    because no command here accepts a principal as the actor.
 *  - every principal has an accountable human owner membership, resolved
 *    server-side; scheduled automation therefore always has an active owner
 *    instead of the last editor's ambient account.
 *  - revocation is a one-way kill switch: revoked rows stay for audit and no
 *    transition leads out of "revoked".
 *
 * Default off: nothing in the request path resolves principals for
 * authorization yet. guards.ts RANK remains the only enforcement surface;
 * runtime adoption is the ADR 0006 (PROPOSAL) slice.
 */

export class AgentPrincipalError extends Error {
  constructor(
    public readonly code:
      | "principal_input"
      | "principal_not_found"
      | "principal_stale"
      | "principal_key_taken"
      | "principal_revoked"
      | "profile_not_found"
      | "owner_not_found"
      | "invalid_status_transition",
    message: string,
  ) {
    super(message);
    this.name = "AgentPrincipalError";
  }
}

export const PRINCIPAL_KEY = /^[a-z][a-z0-9_]{0,49}$/;

export function validatePrincipalKey(key: string): string {
  const trimmed = key.trim();
  if (!PRINCIPAL_KEY.test(trimmed)) {
    throw new AgentPrincipalError(
      "principal_input",
      "Principal keys are 1-50 chars: lowercase letters, digits, underscores, starting with a letter.",
    );
  }
  return trimmed;
}

/** The caller's own active membership, or an explicitly named one - always server-resolved, always active. */
async function resolveOwnerMembership(tx: TxDrizzle, auth: AuthContext, membershipId: string | undefined) {
  const conditions = [
    eq(memberships.workspaceId, auth.workspaceId),
    eq(memberships.status, "active"),
    membershipId ? eq(memberships.id, membershipId) : eq(memberships.userId, auth.userId),
  ];
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(...conditions))
    .limit(1);
  if (!row) {
    throw new AgentPrincipalError(
      "owner_not_found",
      membershipId
        ? "No active membership with that id in this workspace."
        : "You have no active membership in this workspace to own the principal.",
    );
  }
  return row.id;
}

export async function registerAgentPrincipal(
  auth: AuthContext,
  input: {
    key: string;
    kind: "agent" | "service_principal";
    label: string;
    description?: string;
    agentProfileId?: string;
    /** Defaults to the caller's own active membership. */
    ownerMembershipId?: string;
    idempotencyKey?: string;
  },
) {
  requireRole(auth, "admin");
  const key = validatePrincipalKey(input.key);
  const label = input.label.trim();
  if (!label) throw new AgentPrincipalError("principal_input", "A principal needs a label.");
  if (input.kind !== "agent" && input.kind !== "service_principal") {
    throw new AgentPrincipalError("principal_input", `A principal is an agent or a service_principal, not "${input.kind}".`);
  }

  return withTransaction(async (tx) => {
    // State guards live INSIDE the receipt callback: a replayed receipt must
    // return the stored result without re-checking state the first attempt
    // itself changed (the key is now taken, the membership now exists).
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "registerAgentPrincipal", ...input }, async () => {
      const [taken] = await tx
        .select({ id: agentPrincipals.id })
        .from(agentPrincipals)
        .where(and(eq(agentPrincipals.workspaceId, auth.workspaceId), eq(agentPrincipals.key, key)))
        .limit(1);
      if (taken) throw new AgentPrincipalError("principal_key_taken", `The key "${key}" is already used in this workspace.`);
      if (input.agentProfileId) {
        const [profile] = await tx
          .select({ id: agentProfiles.id })
          .from(agentProfiles)
          .where(and(eq(agentProfiles.id, input.agentProfileId), eq(agentProfiles.workspaceId, auth.workspaceId)))
          .limit(1);
        if (!profile) throw new AgentPrincipalError("profile_not_found", "No agent profile with that id in this workspace.");
      }
      const ownerMembershipId = await resolveOwnerMembership(tx, auth, input.ownerMembershipId);
      const [principal] = await tx
        .insert(agentPrincipals)
        .values({
          workspaceId: auth.workspaceId,
          key,
          kind: input.kind,
          label,
          description: input.description ?? null,
          agentProfileId: input.agentProfileId ?? null,
          ownerMembershipId,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "agent_principal.registered",
          subjectType: "agent_principal",
          subjectId: principal.id,
          summary: `Registered ${input.kind} "${key}"`,
          metadata: { key, kind: input.kind, agentProfileId: input.agentProfileId ?? null, ownerMembershipId },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({
        workspaceId: auth.workspaceId,
        topic: "agent_principal.registered",
        payload: { principalId: principal.id, key, kind: input.kind },
      });
      return { principalId: principal.id };
    });
    return { ...value, replayed };
  });
}

/*
 * The legal transitions. Revoked is terminal: a kill switch that can be
 * silently undone is not a kill switch, so re-enabling automation means
 * registering a new principal with its own grants.
 */
const TRANSITIONS: Record<(typeof agentPrincipalStatus.enumValues)[number], ReadonlySet<string>> = {
  active: new Set(["suspended", "revoked"]),
  suspended: new Set(["active", "revoked"]),
  revoked: new Set(),
};

export async function setAgentPrincipalStatus(
  auth: AuthContext,
  input: { principalId: string; status: "active" | "suspended" | "revoked"; expectedVersion: number; idempotencyKey?: string },
) {
  requireRole(auth, "admin");
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "setAgentPrincipalStatus", ...input }, async () => {
      const [principal] = await tx
        .select()
        .from(agentPrincipals)
        .where(and(eq(agentPrincipals.id, input.principalId), eq(agentPrincipals.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!principal) throw new AgentPrincipalError("principal_not_found", "No such principal in this workspace.");
      if (principal.version !== input.expectedVersion) {
        throw new AgentPrincipalError("principal_stale", `Expected version ${input.expectedVersion}, found ${principal.version}. Reload and retry.`);
      }
      if (!TRANSITIONS[principal.status].has(input.status)) {
        if (principal.status === "revoked") {
          throw new AgentPrincipalError("principal_revoked", "A revoked principal is permanent. Register a new principal instead.");
        }
        throw new AgentPrincipalError("invalid_status_transition", `Cannot move a ${principal.status} principal to ${input.status}.`);
      }
      await tx
        .update(agentPrincipals)
        .set({ status: input.status, version: principal.version + 1, updatedBy: auth.userId, updatedAt: new Date() })
        .where(eq(agentPrincipals.id, principal.id));
      await recordAudit(
        auth,
        {
          action: "agent_principal.status_changed",
          subjectType: "agent_principal",
          subjectId: principal.id,
          summary: `Principal "${principal.key}" ${principal.status} -> ${input.status}`,
          metadata: { key: principal.key, from: principal.status, to: input.status },
        },
        tx,
      );
      await tx.insert(outboxEvents).values({
        workspaceId: auth.workspaceId,
        topic: "agent_principal.status_changed",
        payload: { principalId: principal.id, key: principal.key, from: principal.status, to: input.status },
      });
      return { principalId: principal.id, version: principal.version + 1 };
    });
    return { ...value, replayed };
  });
}

/** Principals for management review, active first, newest edit first. */
export async function listAgentPrincipals(
  auth: AuthContext,
  filter?: { kind?: "agent" | "service_principal"; status?: "active" | "suspended" | "revoked" },
) {
  requireRole(auth, "admin");
  const conditions: SQL[] = [eq(agentPrincipals.workspaceId, auth.workspaceId)];
  if (filter?.kind) conditions.push(eq(agentPrincipals.kind, filter.kind));
  if (filter?.status) conditions.push(eq(agentPrincipals.status, filter.status));
  return db.select().from(agentPrincipals).where(and(...conditions)).orderBy(desc(agentPrincipals.updatedAt));
}

/**
 * The read slice 2 (delegation grants) authorizes against: an active
 * principal in this workspace, or nothing. Suspended and revoked are the
 * same refusal on purpose - a paused identity admits no new authority.
 */
export async function getActiveAgentPrincipal(tx: TxDrizzle, workspaceId: string, principalId: string) {
  const [row] = await tx
    .select()
    .from(agentPrincipals)
    .where(
      and(
        eq(agentPrincipals.id, principalId),
        eq(agentPrincipals.workspaceId, workspaceId),
        eq(agentPrincipals.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}
