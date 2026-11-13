"use server";

import {
  getUnderstandingPreferences,
  InvalidUnderstandingPreferenceError,
  saveUnderstandingPreferences,
  UnderstandingPreferenceConflictError,
  type UnderstandingPreferences,
} from "@/domains/understanding/preferences";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import type { Result } from "@/lib/result";

/*
 * The plugin's switches on the Settings screen. Per person, so any member may
 * move their own; the plugin reads the same row over the API.
 */

type Loaded = UnderstandingPreferences & { version: number };

export async function loadUnderstandingPreferencesAction(): Promise<Result<{ preferences: Loaded }>> {
  try {
    const auth = await getAuthContext();
    return { ok: true, preferences: await getUnderstandingPreferences(auth) };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load these preferences.") };
  }
}

export async function saveUnderstandingPreferencesAction(
  input: UnderstandingPreferences & { expectedVersion: number },
): Promise<Result<{ preferences: Loaded }>> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    return { ok: true, preferences: await saveUnderstandingPreferences(auth, input) };
  } catch (error) {
    if (error instanceof InvalidUnderstandingPreferenceError || error instanceof UnderstandingPreferenceConflictError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: actionError(error, "Could not save these preferences.") };
  }
}
