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
import { getDefaultProfile } from "@/domains/agents/queries";
import { updateDefaultProfileBrief } from "@/domains/agents/commands";
import { changeMembership } from "@/domains/identity/invitations";
import { selfMembership } from "@/domains/identity/members";
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
 * D5 membership management. Each verb opens with its own rank guard — the
 * sweep (ASH-121 AC05) pins the boundary, and a viewer must be refused
 * before any domain query runs — then delegates to the identity domain's
 * changeMembership, the enforcement surface for the owner-row matrix and
 * the last-owner invariant. Actions validate shape, translate errors into
 * authored copy, and revalidate the console; they add no policy beyond
 * that floor.
 */

const ROLES = ["owner", "admin", "member", "viewer"] as const;

export async function changeMemberRoleAction(input: {
  membershipId: string;
  role: string;
}): Promise<Result<{ membershipId: string; status: string; role: string }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  const membershipId = String(input?.membershipId ?? "").trim();
  const role = String(input?.role ?? "").trim() as (typeof ROLES)[number];
  if (!membershipId) return { ok: false, error: "Choose a member to update." };
  if (!ROLES.includes(role)) return { ok: false, error: "Choose a role from the list." };
  try {
    requireRole(auth, "admin");
    const changed = await changeMembership(auth, { membershipId, role });
    revalidatePath("/settings/access");
    return { ok: true, ...changed };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not change the role.") };
  }
}

export async function removeMemberAction(input: {
  membershipId: string;
}): Promise<Result<{ membershipId: string; status: string; role: string }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  const membershipId = String(input?.membershipId ?? "").trim();
  if (!membershipId) return { ok: false, error: "Choose a member to remove." };
  try {
    requireRole(auth, "admin");
    const changed = await changeMembership(auth, { membershipId, status: "removed" });
    revalidatePath("/settings/access");
    return { ok: true, ...changed };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not remove the member.") };
  }
}

export async function leaveWorkspaceAction(): Promise<Result<{ left: true }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign-in is not configured on this deployment.") };
  }
  try {
    // The row comes from the session, never from the client: a member could
    // otherwise aim the leave verb at someone else's membership id.
    requireRole(auth, "member");
    const self = await selfMembership(auth);
    if (!self) return { ok: false, error: "You are not a member of this workspace." };
    await changeMembership(auth, { membershipId: self.membershipId, status: "removed" });
    revalidatePath("/settings/access");
    return { ok: true, left: true };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not leave the workspace.") };
  }
}
