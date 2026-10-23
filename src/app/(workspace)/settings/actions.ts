"use server";

import { revalidatePath } from "next/cache";
import {
  getPreferences,
  updatePreferences,
  type AppearanceValue,
  type LoadedPreferences,
  type MotionValue,
  type Preferences,
} from "@/domains/identity/preferences";
import { getDefaultProfile } from "@/domains/agents/queries";
import { updateDefaultProfileBrief } from "@/domains/agents/commands";
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
    return { ok: false, error: error instanceof Error ? error.message : "Sign-in is not configured on this deployment." };
  }
  try {
    return { ok: true, preferences: await getPreferences(auth) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load preferences." };
  }
}

export async function savePreferencesAction(input: {
  expectedVersion: number;
  timezone?: string;
  weekStart?: number;
  appearance?: AppearanceValue;
  motion?: MotionValue;
}): Promise<Result<{ preferences: LoadedPreferences }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Sign-in is not configured on this deployment." };
  }
  requireRole(auth, "member");
  const patch: Partial<Preferences> = {};
  if (input.timezone !== undefined) patch.timezone = String(input.timezone).slice(0, 64);
  if (input.weekStart !== undefined) patch.weekStart = Number(input.weekStart);
  if (input.appearance !== undefined) patch.appearance = input.appearance;
  if (input.motion !== undefined) patch.motion = input.motion;
  try {
    const preferences = await updatePreferences(auth, {
      expectedVersion: Number(input.expectedVersion),
      ...patch,
    });
    revalidatePath("/settings");
    return { ok: true, preferences };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save preferences." };
  }
}

/*
 * The assistant's learned brief (spec "It learns your taste"): review and
 * change what onboarding wrote onto the default profile. Reads are open to
 * the workspace; writes need a member, and the domain compare-and-sets on
 * the rendered version. Retire = save empty, recorded as retired in audit.
 */
export async function loadAssistantProfileAction(): Promise<Result<{ profile: { name: string; description: string | null; instructions: string | null; version: number } | null }>> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Sign-in is not configured on this deployment." };
  }
  try {
    return { ok: true, profile: await getDefaultProfile(auth) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the assistant profile." };
  }
}

export async function saveAssistantProfileAction(input: {
  name: string;
  description?: string;
  instructions?: string;
  expectedVersion: number;
}): Promise<Result<{ profile: { name: string; description: string | null; instructions: string | null; version: number } }> & { kind?: "conflict" | "validation" | "not_found" }> {
  let auth;
  try {
    auth = await getAuthContext();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Sign-in is not configured on this deployment." };
  }
  try {
    requireRole(auth, "member");
    const result = await updateDefaultProfileBrief(auth, input);
    if (!result.ok) {
      if (result.kind === "conflict") return { ok: false, kind: "conflict", error: "The assistant profile changed elsewhere. Reloaded the latest - review and save again." };
      if (result.kind === "not_found") return { ok: false, kind: "not_found", error: "No assistant profile exists yet. It is created when the assistant first runs." };
      return { ok: false, kind: "validation", error: result.error };
    }
    revalidatePath("/settings");
    return { ok: true, profile: result.profile };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the assistant profile." };
  }
}
