import { auditEvents } from "@/domains/audit/schema";
import { withTransaction } from "@/lib/db-transaction";
import { SLUG_PATTERN, slugify } from "@/lib/slug";
import type { AuthContext } from "./resolve";
import { memberships, workspaces } from "./schema";

/*
 * Spec D3: workspace creation. The tables and the resolver already exist;
 * this is the command that lets any signed-in user mint a new tenant and
 * become its owner in one committed transaction - a workspace with a created
 * event but no owner membership would be a tenant nobody can resolve into.
 *
 * The slug is the workspace's unique address. Left on auto (the form sends no
 * slug while its address field is untouched) it derives from the name and
 * suffixes collisions -2, -3, ... so a common name never blocks creation.
 * Hand-edited, it is the user's explicit choice: a collision surfaces as the
 * authored conflict below instead of silently varying.
 */

export class WorkspaceConflictError extends Error {
  constructor(
    public readonly code: "workspace_input" | "workspace_slug_taken",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

const NAME_MAX = 80;
/** A unique violation surviving the loop means contention the suffixes cannot clear. */
const SLUG_ATTEMPTS = 5;

export async function createWorkspace(
  auth: AuthContext,
  input: { name: string; slug?: string },
): Promise<{ workspaceId: string; name: string; slug: string }> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new WorkspaceConflictError("workspace_input", "Give the workspace a name of 1-80 characters.");
  }
  // A hand-typed slug is normalized, not rejected, so "My Space!" becomes
  // my-space; auto mode derives the same way from the name.
  const manualSlug = input.slug?.trim() || undefined;
  const base = slugify(manualSlug ?? name);
  if (!SLUG_PATTERN.test(base)) {
    throw new WorkspaceConflictError(
      "workspace_input",
      manualSlug
        ? "Addresses use lowercase letters, numbers, and hyphens."
        : "The name needs at least one letter or number to build an address.",
    );
  }

  return withTransaction(async (tx) => {
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name, slug, isPersonal: false, createdBy: auth.userId, updatedBy: auth.userId })
        .onConflictDoNothing({ target: workspaces.slug })
        .returning();
      if (!workspace) {
        if (manualSlug) break; // the user's explicit choice is taken: authored conflict
        continue; // auto: try the next suffix
      }
      await tx
        .insert(memberships)
        .values({ workspaceId: workspace.id, userId: auth.userId, role: "owner", status: "active" });
      // The event belongs to the workspace it created; auth.workspaceId still
      // names the caller's previous workspace, so this is a direct insert
      // (acceptInvitation's precedent), not recordAudit.
      await tx.insert(auditEvents).values({
        workspaceId: workspace.id,
        actorId: auth.userId,
        actorKind: "user",
        action: "workspace.created",
        subjectType: "workspace",
        subjectId: workspace.id,
        summary: `Created the ${name} workspace`,
        metadata: { name, slug: workspace.slug },
      });
      return { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug };
    }
    throw new WorkspaceConflictError("workspace_slug_taken", "That address is taken. Pick another.");
  });
}
