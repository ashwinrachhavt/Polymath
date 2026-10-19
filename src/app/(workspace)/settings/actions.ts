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
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Settings writes (D23). One save action for every preference panel: the
 * caller sends only the keys it owns plus the version it rendered, and the
 * domain compare-and-sets. A viewer can read preferences but not move them.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function loadPreferencesAction(): Promise<Result<{ preferences: LoadedPreferences }>> {
  const auth = await getAuthContext();
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
  const auth = await getAuthContext();
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
