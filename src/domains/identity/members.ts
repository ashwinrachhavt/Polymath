import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guards";
import type { AuthContext } from "./resolve";
import { invitations, memberships } from "./schema";
import { users } from "./tables";

/*
 * ASH-121 AC06, read-only slice: the member directory and invitation list an
 * owner or admin sees. Reads only metadata (never a token digest) and mutates
 * nothing; the console's edit actions land after enforcement does.
 */

export type MemberRow = {
  membershipId: string;
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
  requireRole(auth, "admin");
  const rows = await db
    .select({
      membershipId: memberships.id,
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
