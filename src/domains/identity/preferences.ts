import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { userPreferences } from "./schema";

/*
 * D23: preferences saved on the server, one row per (workspace, user). The
 * row - not a browser - is the record, so a setting made on the laptop is the
 * setting the phone and every product surface reads. Writes are
 * compare-and-set on the row version, so two open tabs cannot silently
 * overwrite each other; the loser gets a conflict and reloads.
 *
 * `notificationPolicy`, `modelDefaults` and `budgetDefaults` columns exist on
 * the table for the runtime/policy work that owns them; this module writes
 * only the four owner-facing values it validates.
 */

export type AppearanceValue = "light" | "dark" | "system";
export type MotionValue = "full" | "reduced";

export type Preferences = {
  timezone: string;
  /** ISO weekday: 1 = Monday, 7 = Sunday. */
  weekStart: number;
  appearance: AppearanceValue;
  motion: MotionValue;
};

export const DEFAULT_PREFERENCES: Preferences = {
  timezone: "UTC",
  weekStart: 1,
  appearance: "system",
  motion: "full",
};

/** Version 0 means no row is saved yet; the first save inserts version 1. */
export type LoadedPreferences = Preferences & { version: number };

export class InvalidPreferenceError extends Error {
  readonly code = "invalid_preference";
  constructor(message: string) {
    super(message);
    this.name = "InvalidPreferenceError";
  }
}

export class PreferenceConflictError extends Error {
  readonly code = "preference_conflict";
  constructor() {
    super("These preferences changed in another tab or device. Reload and try again.");
    this.name = "PreferenceConflictError";
  }
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Throws InvalidPreferenceError on the first bad value; returns the patch unchanged. */
export function validatePreferencePatch(patch: Partial<Preferences>): Partial<Preferences> {
  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string" || patch.timezone.length < 1 || patch.timezone.length > 64) {
      throw new InvalidPreferenceError("Timezone must be an IANA identifier such as America/Los_Angeles.");
    }
    if (!isValidTimezone(patch.timezone)) {
      throw new InvalidPreferenceError(`"${patch.timezone}" is not a recognized IANA timezone.`);
    }
  }
  if (patch.weekStart !== undefined) {
    if (!Number.isInteger(patch.weekStart) || patch.weekStart < 1 || patch.weekStart > 7) {
      throw new InvalidPreferenceError("Week start must be an ISO weekday: 1 (Monday) through 7 (Sunday).");
    }
  }
  if (patch.appearance !== undefined && !["light", "dark", "system"].includes(patch.appearance)) {
    throw new InvalidPreferenceError("Appearance must be light, dark or system.");
  }
  if (patch.motion !== undefined && !["full", "reduced"].includes(patch.motion)) {
    throw new InvalidPreferenceError("Motion must be full or reduced.");
  }
  return patch;
}

export async function getPreferences(auth: AuthContext): Promise<LoadedPreferences> {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.workspaceId, auth.workspaceId), eq(userPreferences.userId, auth.userId)))
    .limit(1);
  if (!row) return { ...DEFAULT_PREFERENCES, version: 0 };
  return {
    timezone: row.timezone,
    weekStart: row.weekStart,
    appearance: row.appearance,
    motion: row.motion,
    version: row.version,
  };
}

export async function updatePreferences(
  auth: AuthContext,
  input: Partial<Preferences> & { expectedVersion: number },
): Promise<LoadedPreferences> {
  const patch = validatePreferencePatch({
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.weekStart !== undefined ? { weekStart: input.weekStart } : {}),
    ...(input.appearance !== undefined ? { appearance: input.appearance } : {}),
    ...(input.motion !== undefined ? { motion: input.motion } : {}),
  });
  return withTransaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.workspaceId, auth.workspaceId), eq(userPreferences.userId, auth.userId)))
      .limit(1);

    if (!current) {
      // The first save must know it is the first save: any other expectation
      // means the caller's view is stale.
      if (input.expectedVersion !== 0) throw new PreferenceConflictError();
      const values = { ...DEFAULT_PREFERENCES, ...patch };
      const [inserted] = await tx
        .insert(userPreferences)
        .values({
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          timezone: values.timezone,
          weekStart: values.weekStart,
          appearance: values.appearance,
          motion: values.motion,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(auth, {
        action: "preferences.saved",
        subjectType: "user_preferences",
        subjectId: inserted.id,
        summary: `Preferences saved (first write): timezone ${inserted.timezone}, week starts ISO day ${inserted.weekStart}, ${inserted.appearance} appearance, ${inserted.motion} motion`,
      }, tx);
      return {
        timezone: inserted.timezone,
        weekStart: inserted.weekStart,
        appearance: inserted.appearance,
        motion: inserted.motion,
        version: inserted.version,
      };
    }

    const merged = {
      timezone: patch.timezone ?? current.timezone,
      weekStart: patch.weekStart ?? current.weekStart,
      appearance: patch.appearance ?? current.appearance,
      motion: patch.motion ?? current.motion,
    };
    const [updated] = await tx
      .update(userPreferences)
      .set({
        ...merged,
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${userPreferences.version} + 1`,
      })
      .where(
        and(
          eq(userPreferences.id, current.id),
          eq(userPreferences.workspaceId, auth.workspaceId),
          eq(userPreferences.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw new PreferenceConflictError();
    await recordAudit(auth, {
      action: "preferences.saved",
      subjectType: "user_preferences",
      subjectId: updated.id,
      summary: `Preferences saved: timezone ${updated.timezone}, week starts ISO day ${updated.weekStart}, ${updated.appearance} appearance, ${updated.motion} motion`,
    }, tx);
    return {
      timezone: updated.timezone,
      weekStart: updated.weekStart,
      appearance: updated.appearance,
      motion: updated.motion,
      version: updated.version,
    };
  });
}
