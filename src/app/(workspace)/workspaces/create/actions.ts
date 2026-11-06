"use server";

import { revalidatePath, updateTag } from "next/cache";
import { createWorkspace } from "@/domains/identity/workspaces";
import { writeActiveWorkspaceCookie } from "@/lib/active-workspace";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { workspacesTag } from "@/lib/cache-tags";
import { requireRole } from "@/lib/auth/guards";
import type { Result } from "@/lib/result";

/*
 * Workspace creation (spec D3). Any signed-in user may create a workspace and
 * becomes its owner inside the command. The action resolves the session,
 * shapes the result, and lands the creator in the new workspace by writing
 * the per-device active-workspace cookie (T1): the next request resolves
 * there, where the product's first-run gate picks the route. A slug
 * collision comes back as the domain's authored copy.
 */

export async function createWorkspaceAction(input: { name: string; slug?: string }): Promise<Result<{ slug: string }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  // Spec D3: any signed-in user may create a workspace (Notion parity) - the
  // write lands in a NEW tenant, never the caller's own, so no role above the
  // floor applies. requireRole at the viewer rank keeps that legible where
  // the authorization sweep looks; getAuthContext has already proven the
  // active membership it re-states.
  requireRole(auth, "viewer");
  try {
    const workspace = await createWorkspace(auth, {
      name: String(input.name ?? ""),
      slug: input.slug === undefined ? undefined : String(input.slug),
    });
    // The creator lands in the new workspace: the cookie decides the workspace
    // of the very next request, and the client island follows with a full
    // navigation (a context change, not a partial refresh).
    await writeActiveWorkspaceCookie(workspace.workspaceId);
    // The creator's switcher is cached per user; the new membership must be
    // on the next render — the action itself triggers a full navigation.
    updateTag(workspacesTag(auth.userId));
    revalidatePath("/", "layout");
    return { ok: true, slug: workspace.slug };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not create the workspace.") };
  }
}
