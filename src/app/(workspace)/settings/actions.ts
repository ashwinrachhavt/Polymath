"use server";

import { revalidatePath } from "next/cache";
import {
  getPreferences,
  updatePreferences,
  type AppearanceValue,
  type InterfaceModeValue,
  type LoadedPreferences,
  type MotionValue,
  type Preferences,
} from "@/domains/identity/preferences";
import { createInvitation, revokeInvitation } from "@/domains/identity/invitations";
import { getDefaultProfile } from "@/domains/agents/queries";
import { updateDefaultProfileBrief } from "@/domains/agents/commands";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Settings writes (D23). One save action for every preference panel: the
 * caller sends only the keys it owns plus the version it rendered, and the
 * domain compare-and-sets. A viewer can read preferences but not move them.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function loadPreferencesAction(): Promise<Result<{ preferences: LoadedPreferences }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    // A deployment without sign-in (no Clerk keys) still renders /settings as
    // a browser preview; the load failing must be a named result, not an
    // unhandled server-action rejection (ASH-193).
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  try {
    return { ok: true, preferences: await getPreferences(auth) };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load preferences.") };
  }
}

export async function savePreferencesAction(input: {
  expectedVersion: number;
  timezone?: string;
  weekStart?: number;
  appearance?: AppearanceValue;
  motion?: MotionValue;
  interfaceMode?: InterfaceModeValue;
}): Promise<Result<{ preferences: LoadedPreferences }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  requireRole(auth, "member");
  const patch: Partial<Preferences> = {};
  if (input.timezone !== undefined) patch.timezone = String(input.timezone).slice(0, 64);
  if (input.weekStart !== undefined) patch.weekStart = Number(input.weekStart);
  if (input.appearance !== undefined) patch.appearance = input.appearance;
  if (input.motion !== undefined) patch.motion = input.motion;
  if (input.interfaceMode !== undefined) patch.interfaceMode = input.interfaceMode;
  try {
    const preferences = await updatePreferences(auth, {
      expectedVersion: Number(input.expectedVersion),
      ...patch,
    });
    revalidatePath("/settings");
    return { ok: true, preferences };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not save preferences.") };
  }
}

/*
 * The assistant's learned brief (spec "It learns your taste"): review and
 * change what onboarding wrote onto the default profile. Reads are open to
 * the workspace; writes need a member, and the domain compare-and-sets on
 * the rendered version. Retire = save empty, recorded as retired in audit.
 */
export async function loadAssistantProfileAction(): Promise<
  Result<{ profile: { name: string; description: string | null; instructions: string | null; version: number } | null }>
> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  try {
    // Owner only: the brief is written by onboarding into the person's own
    // workspace and carries personal working/writing preferences. No
    // pre-existing policy grants members or viewers a raw-brief read, so the
    // new surface stays at the grounded owner scope until the owner decides
    // who else may read it (recorded as open).
    requireRole(auth, "owner");
    return { ok: true, profile: await getDefaultProfile(auth) };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load the assistant profile.") };
  }
}

export async function saveAssistantProfileAction(input: {
  description?: string;
  instructions?: string;
  expectedVersion: number;
}): Promise<
  Result<{ profile: { name: string; description: string | null; instructions: string | null; version: number } }> & {
    kind?: "conflict" | "validation" | "not_found";
  }
> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  try {
    // Owner only, same grounding as the read above.
    requireRole(auth, "owner");
    const result = await updateDefaultProfileBrief(auth, input);
    if (!result.ok) {
      if (result.kind === "conflict")
        return {
          ok: false,
          kind: "conflict",
          error: "The assistant profile changed elsewhere. Reloaded the latest - review and save again.",
        };
      if (result.kind === "not_found")
        return {
          ok: false,
          kind: "not_found",
          error: "No assistant profile exists yet. It is created when the assistant first runs.",
        };
      return { ok: false, kind: "validation", error: result.error };
    }
    revalidatePath("/settings");
    return { ok: true, profile: result.profile };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not save the assistant profile.") };
  }
}

/*
 * Invitation lifecycle (spec D4): the first wired callers of the ASH-121
 * domain. The domain is the enforcement surface - createInvitation and
 * revokeInvitation require an admin, scope every write to the caller's
 * workspace, and record the audit entries - so these actions only resolve
 * the context, shape the result, and refresh the console. The raw token
 * crosses exactly once, to the admin who can share the link; only its
 * digest is stored.
 */

export async function createInvitationAction(input: {
  email: string;
  role?: string;
}): Promise<Result<{ invitationId: string; token: string; invitePath: string; expiresAt: Date }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  const role = input.role === "admin" || input.role === "viewer" ? input.role : "member";
  try {
    const invitation = await createInvitation(auth, { email: String(input.email), role });
    revalidatePath("/settings/access");
    return {
      ok: true,
      invitationId: invitation.invitationId,
      token: invitation.token,
      invitePath: `/invitations/${invitation.token}`,
      expiresAt: invitation.expiresAt,
    };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not send the invitation.") };
  }
}

export async function revokeInvitationAction(invitationId: string): Promise<Result<{ revoked: boolean }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  try {
    const result = await revokeInvitation(auth, String(invitationId));
    revalidatePath("/settings/access");
    return { ok: true, revoked: result.revoked };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not revoke the invitation.") };
  }
}
