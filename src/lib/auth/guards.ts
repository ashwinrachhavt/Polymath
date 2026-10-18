import type { AuthContext } from "@/lib/auth";
import type { AuthRole } from "@/domains/identity/resolve";

/*
 * One guard per concept (ASH-120 F03). Deliberately not a permission
 * framework: a hierarchy comparison and a tenant equality check are the whole
 * surface. Custom roles are post-v1 (ADR 0001).
 *
 * Policy, the short version of ADR 0001: membership is the only source of
 * authorization. Customer, subscriber, and business-relationship records
 * (party_relationships, contact_points, professional labels) grant nothing.
 * Roles cannot self-escalate — `role` is read from the memberships table at
 * resolution time (identity/resolve.ts), never from session or client input.
 * Checks re-run at execution time.
 */

export type Role = AuthRole;

// `?? -1` keeps an unknown role fail-closed: without it, `undefined < n` is
// false and an out-of-enum role would pass every check.
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Thrown by the guards; route handlers map it through problemResponse. */
export class ForbiddenRoleError extends Error {
  constructor(
    public readonly code: "AUTH_FORBIDDEN" | "AUTH_WORKSPACE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ForbiddenRoleError";
  }
}

/** Throws unless the context's role meets or exceeds `minimum`. */
export function requireRole(ctx: AuthContext, minimum: Role): void {
  if ((RANK[ctx.role] ?? -1) < RANK[minimum]) {
    throw new ForbiddenRoleError(
      "AUTH_FORBIDDEN",
      `Requires ${minimum}; this member is ${ctx.role}.`,
    );
  }
}

/**
 * Throws if a queried row belongs to another workspace. Run it on rows that
 * arrive from an unscoped path; queries should scope at the source with
 * eq(table.workspaceId, ctx.workspaceId) so a foreign row is never fetched.
 */
export function assertWorkspaceScope(
  row: { workspaceId: string },
  ctx: AuthContext,
): void {
  if (row.workspaceId !== ctx.workspaceId) {
    throw new ForbiddenRoleError(
      "AUTH_WORKSPACE_MISMATCH",
      "Record belongs to another workspace.",
    );
  }
}
