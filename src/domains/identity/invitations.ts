import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { auditEvents } from "@/domains/audit/schema";
import { requireRole } from "@/lib/auth/guards";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import type { AuthContext } from "./resolve";
import { invitations, memberships } from "./schema";

/*
 * ASH-121 AC02: membership and invitation lifecycle. Default off - no route
 * calls this yet and guards.ts RANK stays the enforcement surface. What this
 * slice proves: invitations are single-use, expiring, revocable and bound to a
 * recipient email; acceptance needs a VERIFIED email (the identity provider's
 * claim, never a self-asserted one); and the last active owner can never be
 * suspended, removed or demoted, even under concurrent requests.
 */

export class MembershipLifecycleError extends Error {
  constructor(
    public readonly code:
      | "invitation_input"
      | "invitation_invalid"
      | "invitation_exists"
      | "membership_not_found"
      | "last_owner",
    message: string,
  ) {
    super(message);
    this.name = "MembershipLifecycleError";
  }
}

const DEFAULT_TTL_HOURS = 24 * 7;
const MAX_TTL_HOURS = 24 * 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Returns the raw token exactly once; only its digest is stored. */
export async function createInvitation(
  auth: AuthContext,
  input: { email: string; role?: "admin" | "member" | "viewer"; ttlHours?: number },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  requireRole(auth, "owner");
  const email = normalizeEmail(input.email);
  if (!EMAIL.test(email)) throw new MembershipLifecycleError("invitation_input", "Enter a valid email address.");
  const ttl = input.ttlHours ?? DEFAULT_TTL_HOURS;
  if (!(ttl > 0) || ttl > MAX_TTL_HOURS) {
    throw new MembershipLifecycleError("invitation_input", `An invitation lasts between 1 hour and ${MAX_TTL_HOURS} hours.`);
  }
  const token = `inv_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = new Date(Date.now() + ttl * 3600_000);

  return withTransaction(async (tx) => {
    // An expired but never-resolved invitation would block the partial unique
    // index forever; retire it so the recipient can be invited again.
    await tx
      .update(invitations)
      .set({ revokedAt: new Date(), revokedBy: auth.userId, updatedAt: new Date() })
      .where(and(
        eq(invitations.workspaceId, auth.workspaceId),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        sql`${invitations.expiresAt} <= now()`,
      ));
    const inserted = await tx
      .insert(invitations)
      .values({
        workspaceId: auth.workspaceId,
        email,
        role: input.role ?? "member",
        tokenHash: await sha256Hex(token),
        expiresAt,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing()
      .returning({ id: invitations.id });
    if (inserted.length === 0) {
      throw new MembershipLifecycleError("invitation_exists", "That address already has a pending invitation. Revoke it to send another.");
    }
    await recordAudit(auth, {
      action: "invitation.created",
      subjectType: "invitation",
      subjectId: inserted[0].id,
      summary: `Invited ${email} as ${input.role ?? "member"}`,
      metadata: { email, role: input.role ?? "member", expiresAt },
    }, tx);
    return { invitationId: inserted[0].id, token, expiresAt };
  });
}

export async function revokeInvitation(auth: AuthContext, invitationId: string): Promise<{ revoked: boolean }> {
  requireRole(auth, "owner");
  return withTransaction(async (tx) => {
    const rows = await tx
      .update(invitations)
      .set({ revokedAt: new Date(), revokedBy: auth.userId, updatedAt: new Date() })
      .where(and(
        eq(invitations.id, invitationId),
        eq(invitations.workspaceId, auth.workspaceId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ))
      .returning({ id: invitations.id });
    if (rows.length === 0) return { revoked: false };
    await recordAudit(auth, {
      action: "invitation.revoked",
      subjectType: "invitation",
      subjectId: invitationId,
      summary: "Revoked an invitation",
    }, tx);
    return { revoked: true };
  });
}

/**
 * The invitee has no workspace context yet, so this takes the caller's user id
 * and the identity provider's verified email directly. One conditional UPDATE
 * claims the invitation; of two racing accepts only one wins. Every failure is
 * the same "invalid" so a probe learns nothing about which tokens exist.
 * Replay by the same user returns the existing membership.
 */
export async function acceptInvitation(input: {
  token: string;
  userId: string;
  verifiedEmail: string | null;
}): Promise<{ workspaceId: string; membershipId: string; role: string; replayed: boolean }> {
  const invalid = () => new MembershipLifecycleError("invitation_invalid", "This invitation is not valid.");
  if (!input.verifiedEmail) throw invalid();
  const email = normalizeEmail(input.verifiedEmail);
  const tokenHash = await sha256Hex(input.token);

  return withTransaction(async (tx) => {
    const claimed = await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedBy: input.userId, updatedAt: new Date() })
      .where(and(
        eq(invitations.tokenHash, tokenHash),
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ))
      .returning();
    if (claimed.length === 0) {
      const [prior] = await tx
        .select({ workspaceId: invitations.workspaceId, acceptedBy: invitations.acceptedBy, email: invitations.email })
        .from(invitations)
        .where(and(eq(invitations.tokenHash, tokenHash), isNull(invitations.revokedAt)))
        .limit(1);
      if (prior?.acceptedBy === input.userId && prior.email === email) {
        const [existing] = await tx
          .select({ id: memberships.id, role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.workspaceId, prior.workspaceId), eq(memberships.userId, input.userId)))
          .limit(1);
        if (existing) return { workspaceId: prior.workspaceId, membershipId: existing.id, role: existing.role, replayed: true };
      }
      throw invalid();
    }
    const invite = claimed[0];
    // A removed or suspended member re-joins through a fresh invitation; an
    // active member keeps their current role (an invitation never demotes).
    const [member] = await tx
      .insert(memberships)
      .values({ workspaceId: invite.workspaceId, userId: input.userId, role: invite.role, status: "active" })
      .onConflictDoUpdate({
        target: [memberships.workspaceId, memberships.userId],
        set: {
          status: "active",
          role: sql`case when ${memberships.status} = 'active' then ${memberships.role} else excluded.role end`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: memberships.id, role: memberships.role });
    await tx.insert(auditEvents).values({
      workspaceId: invite.workspaceId,
      actorId: input.userId,
      actorKind: "user",
      action: "invitation.accepted",
      subjectType: "invitation",
      subjectId: invite.id,
      summary: `Accepted an invitation as ${member.role}`,
    });
    return { workspaceId: invite.workspaceId, membershipId: member.id, role: member.role, replayed: false };
  });
}

/**
 * Suspend, reactivate or remove a membership, or change its role. Every
 * change that could leave the workspace without an active owner takes a row
 * lock on the workspace's owner memberships first, so two concurrent
 * demotions serialize and the second sees the first's result.
 */
export async function changeMembership(
  auth: AuthContext,
  input: { membershipId: string; status?: "active" | "suspended" | "removed"; role?: "owner" | "admin" | "member" | "viewer" },
): Promise<{ membershipId: string; status: string; role: string }> {
  requireRole(auth, "owner");
  if (!input.status && !input.role) {
    throw new MembershipLifecycleError("invitation_input", "Nothing to change.");
  }
  return withTransaction(async (tx) => {
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, auth.workspaceId), eq(memberships.role, "owner"), eq(memberships.status, "active")))
      .orderBy(memberships.id)
      .for("update");
    const [target] = await tx
      .select({ id: memberships.id, role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.id, input.membershipId), eq(memberships.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!target) throw new MembershipLifecycleError("membership_not_found", "No such member in this workspace.");

    const nextStatus = input.status ?? target.status;
    const nextRole = input.role ?? target.role;
    const losesOwner = target.role === "owner" && target.status === "active" && (nextStatus !== "active" || nextRole !== "owner");
    if (losesOwner && owners.length <= 1) {
      throw new MembershipLifecycleError("last_owner", "A workspace needs at least one active owner.");
    }
    await tx
      .update(memberships)
      .set({ status: nextStatus, role: nextRole, updatedBy: auth.userId, updatedAt: new Date(), version: sql`${memberships.version} + 1` })
      .where(eq(memberships.id, target.id));
    await recordAudit(auth, {
      action: "membership.changed",
      subjectType: "membership",
      subjectId: target.id,
      summary: `Membership ${target.status}/${target.role} -> ${nextStatus}/${nextRole}`,
      metadata: { from: { status: target.status, role: target.role }, to: { status: nextStatus, role: nextRole } },
    }, tx);
    return { membershipId: target.id, status: nextStatus, role: nextRole };
  });
}
