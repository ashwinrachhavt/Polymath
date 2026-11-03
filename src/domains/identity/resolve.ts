import { cache } from "react";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { seedTaxonomyCatalog } from "@/domains/knowledge/taxonomy";
import { readActiveWorkspaceCookie } from "@/lib/active-workspace";
import { db } from "@/lib/db";
import { memberships, users, workspaces } from "./schema";

/*
 * Clerk owns authentication; this resolves the internal identity it maps onto.
 * A user holds one membership per workspace (tenancy activation, spec D1), so
 * resolution picks the per-device active workspace: the cookie's choice among
 * memberships proved active right now, falling back to the personal
 * workspace, then the first active one. Membership rows — never the cookie —
 * remain the only source of authorization; the cookie only chooses among
 * memberships this query just proved.
 *
 * Wrapped in React cache() so parallel server components in one request share
 * a single resolution instead of racing three identical upserts.
 */

export type AuthRole = "owner" | "admin" | "member" | "viewer";

export type AuthContext = {
  userId: string;
  workspaceId: string;
  role: AuthRole;
  /**
   * Machine clients only: the API key's scopes. Undefined for humans, whose
   * role check is the whole guard — requireScope is a no-op for them.
   */
  scopes?: string[];
};

/** One active membership, with the workspace column selection picks on. */
type ActiveMembership = {
  userId: string;
  workspaceId: string;
  role: AuthRole;
  isPersonal: boolean;
};

/**
 * Every active membership the Clerk user holds, oldest first. The filters are
 * the tenancy invariants: suspended or removed memberships drop out (so a
 * cookie naming one goes stale by construction) and archived workspaces are
 * never resolvable.
 */
async function listActiveMembershipsWithWorkspace(clerkUserId: string): Promise<ActiveMembership[]> {
  return db
    .select({
      userId: users.id,
      workspaceId: memberships.workspaceId,
      role: memberships.role,
      isPersonal: workspaces.isPersonal,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(users.clerkUserId, clerkUserId), eq(memberships.status, "active"), isNull(workspaces.archivedAt)))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

export const resolveAuthContext = cache(async (clerkUserId: string): Promise<AuthContext> => {
  // The common path is one indexed read: every active membership for the
  // user. The upsert below used to run on every request and stamp updated_at,
  // turning every page render (and every link prefetch) into a write.
  // Provisioning still only runs when that read finds no active membership.
  const memberships = await listActiveMembershipsWithWorkspace(clerkUserId);
  if (memberships.length === 0) return provisionFirstSignIn(clerkUserId);

  // Machine clients never reach this function — getAnyAuthContext resolves
  // them from their api_client binding — so the cookie is a human-session
  // concept by construction and the machine path cannot read it.
  const requested = await readActiveWorkspaceCookie();
  const selected =
    memberships.find((m) => m.workspaceId === requested) ?? memberships.find((m) => m.isPersonal) ?? memberships[0];
  return { userId: selected.userId, workspaceId: selected.workspaceId, role: selected.role };
});

/**
 * First sign-in — or the first after every membership went away. Kept
 * byte-identical to the pre-multi-workspace provisioning path so the
 * existing tests pin the same behavior.
 */
async function provisionFirstSignIn(clerkUserId: string): Promise<AuthContext> {
  // Upsert rather than select-then-insert: two first requests racing on a new
  // account must land on one row, and clerk_user_id is unique for exactly this.
  const [user] = await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: sql`now()` } })
    .returning();

  const existing = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"), isNull(workspaces.archivedAt)))
    .limit(1);

  if (existing.length > 0) {
    return { userId: user.id, workspaceId: existing[0].workspaceId, role: existing[0].role };
  }

  // v1: suspended owner still resolves owner; revisit when memberships serve
  // more than one user. With one owner per workspace there is nobody left to
  // hand the workspace to, so the suspended row is the only membership anyway.
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: "Personal", slug: `personal-${user.id}`, isPersonal: true })
    .onConflictDoUpdate({ target: workspaces.slug, set: { updatedAt: sql`now()` } })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: workspace.id, userId: user.id, role: "owner", status: "active" })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
  // ASH-272: a freshly provisioned workspace gets the seeded taxonomy catalog
  // (idempotent upsert; a race with another provisioner folds). This branch
  // only runs when no membership existed, so the hot resolve path never pays
  // for it.
  await seedTaxonomyCatalog(workspace.id);
  return { userId: user.id, workspaceId: workspace.id, role: "owner" };
}

/** One row of the workspace switcher (spec D2): an active membership's workspace. */
export type SwitchableWorkspace = {
  workspaceId: string;
  name: string;
  slug: string;
  role: AuthRole;
  isPersonal: boolean;
};

/**
 * Every workspace the user may switch to (spec D2), keyed by the internal user
 * id the layout already holds. Same filters as resolution — active membership,
 * workspace not archived — so the switcher can never offer a row the resolver
 * would refuse, and oldest first, so its order matches the resolver's
 * fallback order (personal workspace first).
 */
export async function listSwitchableWorkspaces(userId: string): Promise<SwitchableWorkspace[]> {
  return db
    .select({
      workspaceId: memberships.workspaceId,
      name: workspaces.name,
      slug: workspaces.slug,
      role: memberships.role,
      isPersonal: workspaces.isPersonal,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), isNull(workspaces.archivedAt)))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

/**
 * The role a user currently holds in a workspace, or null when they hold no
 * active membership or the workspace is archived. The gateway runs this on
 * every call: a token names the user and workspace it was minted for, but only
 * the database knows whether that membership still exists.
 */
export async function activeMembershipRole(workspaceId: string, userId: string): Promise<AuthRole | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

/**
 * Re-proves a workspace binding that arrived as a claim (the Eve bridge token):
 * the user must hold an active membership in that workspace right now, with the
 * role the claim states, and the workspace must not be archived. Returns the
 * context only on an exact match, so a stale or forged claim gets nothing.
 */
export async function verifyWorkspaceBinding(claim: {
  userId: string;
  workspaceId: string;
  role: AuthRole;
}): Promise<AuthContext | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, claim.userId),
        eq(memberships.workspaceId, claim.workspaceId),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);
  if (!row || row.role !== claim.role) return null;
  return { userId: claim.userId, workspaceId: claim.workspaceId, role: row.role };
}
