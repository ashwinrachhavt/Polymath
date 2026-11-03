"use server";

import { revalidatePath, updateTag } from "next/cache";
import { activeMembershipRole } from "@/domains/identity/resolve";
import { actionError } from "@/lib/action-error";
import { writeActiveWorkspaceCookie } from "@/lib/active-workspace";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { capturesTag, focusTag, tasksTag } from "@/lib/cache-tags";

/*
 * Workspace switching (tenancy activation, spec D1). Self-service for every
 * role: the action re-proves the membership in the database — a stale UI list
 * can offer nothing the membership table disagrees with — then moves the
 * per-device cookie and flushes the shell. Switching never mutates either
 * workspace; the next request's resolver does the rest.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function authorize() {
  const auth = await getAuthContext();
  // Every role may switch among the workspaces it belongs to; viewer is the
  // floor of the guard's ranking, so this states "any membership at all".
  requireRole(auth, "viewer");
  return auth;
}

export async function switchWorkspaceAction(input: { workspaceId: string }): Promise<Result<{ workspaceId: string }>> {
  const auth = await authorize();
  try {
    const role = await activeMembershipRole(input.workspaceId, auth.userId);
    if (!role) return { ok: false, error: "You are not a member of that workspace." };
    await writeActiveWorkspaceCookie(input.workspaceId);

    // The switch changes the auth context every surface reads, so the shell
    // re-renders in the new workspace: bump the workspace-scoped cache tags
    // and invalidate the root layout (top bar, breadcrumb, nav) for every
    // route, since a context change is not a single-page event.
    const next = { userId: auth.userId, workspaceId: input.workspaceId, role };
    updateTag(tasksTag(next));
    updateTag(capturesTag(next));
    updateTag(focusTag(next));
    revalidatePath("/", "layout");
    return { ok: true, workspaceId: input.workspaceId };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not switch workspaces.") };
  }
}
