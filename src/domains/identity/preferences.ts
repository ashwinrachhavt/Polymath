import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { ACCENTS, DEFAULT_ACCENT, isAccent, type Accent } from "@/lib/appearance";
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
 * only the owner-facing values it validates.
 */

export type AppearanceValue = "light" | "dark" | "system";
export type MotionValue = "full" | "reduced";
/** ASH-312: the two interface languages, or "auto" to resolve by time of day. */
export type InterfaceModeValue = "library" | "action" | "auto";
export type AccentValue = Accent;

export type Preferences = {
  timezone: string;
  /** ISO weekday: 1 = Monday, 7 = Sunday. */
  weekStart: number;
  appearance: AppearanceValue;
  motion: MotionValue;
  interfaceMode: InterfaceModeValue;
  /** The accent swatch from the top bar; every surface reads it through --signal. */
  accent: AccentValue;
};

export const DEFAULT_PREFERENCES: Preferences = {
  timezone: "UTC",
  weekStart: 1,
  appearance: "system",
  motion: "full",
  interfaceMode: "auto",
  accent: DEFAULT_ACCENT,
};

/*
 * ASH-312, reversible interpretation (the ticket asks for deliberate or
 * automatic switching "based on time of day or the current session" without
 * pinning hours): auto resolves to the action surface during the owner's
 * local working day (08:00-18:00) and the library surface outside it. The
 * hour is read in the saved timezone; an unrecognised timezone falls back to
 * UTC rather than guessing a zone.
 */
export function resolveInterfaceMode(
  mode: InterfaceModeValue,
  timezone: string,
  now: Date = new Date(),
): "library" | "action" {
  if (mode !== "auto") return mode;
  const zone = isValidTimezone(timezone) ? timezone : "UTC";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).format(now));
  return hour >= 8 && hour < 18 ? "action" : "library";
}

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
  if (patch.interfaceMode !== undefined && !["library", "action", "auto"].includes(patch.interfaceMode)) {
    throw new InvalidPreferenceError("Interface mode must be library, action or auto.");
  }
  if (patch.accent !== undefined && !isAccent(patch.accent)) {
    throw new InvalidPreferenceError(`Accent must be one of ${ACCENTS.map((a) => a.value).join(", ")}.`);
  }
  return patch;
}

type PreferenceRow = typeof userPreferences.$inferSelect;

function toLoaded(row: PreferenceRow): LoadedPreferences {
  return {
    timezone: row.timezone,
    weekStart: row.weekStart,
    appearance: row.appearance,
    motion: row.motion,
    interfaceMode: row.interfaceMode,
    // The column is text so the palette can change without an enum migration;
    // a retired swatch reads as the default rather than an unknown value.
    accent: isAccent(row.accent) ? row.accent : DEFAULT_ACCENT,
    version: row.version,
  };
}

export async function getPreferences(auth: AuthContext): Promise<LoadedPreferences> {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.workspaceId, auth.workspaceId), eq(userPreferences.userId, auth.userId)))
    .limit(1);
  if (!row) return { ...DEFAULT_PREFERENCES, version: 0 };
  return toLoaded(row);
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
    ...(input.interfaceMode !== undefined ? { interfaceMode: input.interfaceMode } : {}),
    ...(input.accent !== undefined ? { accent: input.accent } : {}),
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
          interfaceMode: values.interfaceMode,
          accent: values.accent,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "preferences.saved",
          subjectType: "user_preferences",
          subjectId: inserted.id,
          summary: `Preferences saved (first write): timezone ${inserted.timezone}, week starts ISO day ${inserted.weekStart}, ${inserted.appearance} appearance, ${inserted.motion} motion, ${inserted.accent} accent`,
        },
        tx,
      );
      return toLoaded(inserted);
    }

    // Patch semantics: a write that does not name interfaceMode leaves the
    // stored mode alone, so older clients never clobber a newer one's choice.
    const merged = {
      timezone: patch.timezone ?? current.timezone,
      weekStart: patch.weekStart ?? current.weekStart,
      appearance: patch.appearance ?? current.appearance,
      motion: patch.motion ?? current.motion,
      interfaceMode: patch.interfaceMode ?? current.interfaceMode,
      accent: patch.accent ?? current.accent,
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
    await recordAudit(
      auth,
      {
        action: "preferences.saved",
        subjectType: "user_preferences",
        subjectId: updated.id,
        summary: `Preferences saved: timezone ${updated.timezone}, week starts ISO day ${updated.weekStart}, ${updated.appearance} appearance, ${updated.motion} motion, ${updated.accent} accent`,
      },
      tx,
    );
    return toLoaded(updated);
  });
}
