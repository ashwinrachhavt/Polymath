import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guards";
import type { AuthContext } from "./resolve";
import { invitations, memberships } from "./schema";
import { users } from "./tables";

/*
 * ASH-121 AC06: the member directory and invitation list. The directory is
 * readable by every member (D5: a member sees the table without action
 * buttons); invitations carry candidate members' email addresses, so their
 * list stays admin-only. Reads only metadata (never a token digest).
 */

export type MemberRow = {
  membershipId: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  role: string;
  status: string;
  since: Date;
};

export type InvitationRow = {
  id: string;
  email: string;
  role: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: Date;
  createdAt: Date;
};

export async function listMembers(auth: AuthContext): Promise<MemberRow[]> {
  requireRole(auth, "member");
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      displayName: users.displayName,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      since: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, auth.workspaceId), isNull(memberships.archivedAt)))
    .orderBy(memberships.createdAt);
  return rows;
}

export async function listInvitations(auth: AuthContext, now: Date = new Date()): Promise<InvitationRow[]> {
  requireRole(auth, "admin");
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.workspaceId, auth.workspaceId))
    .orderBy(desc(invitations.createdAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    state: r.acceptedAt ? "accepted" : r.revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "pending",
  }));
}

/**
 * The caller's own membership in the active workspace. Leave is self-service
 * (D5), so the action derives the row from the session rather than trusting a
 * client-supplied membership id — a member can never aim the leave verb at
 * someone else's row.
 */
export async function selfMembership(auth: AuthContext): Promise<MemberRow | null> {
  requireRole(auth, "member");
  const [row] = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      displayName: users.displayName,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      since: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, auth.workspaceId),
        eq(memberships.userId, auth.userId),
        isNull(memberships.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/*
 * Batched display names for audit actor attribution: the presenter hydrates
 * every user-kind actor on a page with one query instead of per-row reads.
 * Names only, never emails, and no role gate - a workspace's audit rows are
 * member-visible, so the actor's name rides the same visibility as the row.
 */
export async function getUserDisplayNames(userIds: string[]): Promise<Map<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(rows.map((row) => [row.id, row.displayName]));
}
