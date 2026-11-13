import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { understandingPreferences } from "./schema";

/*
 * The plugin's switches, one row per person. No row means the defaults, and
 * every default is off or the smallest: the plugin does nothing the person did
 * not ask for. Saves are compare-and-set on the row version, like the other
 * preference screens, so two tabs cannot silently overwrite each other.
 */

const QUESTION_COUNTS = [5, 6, 7, 8, 9, 10] as const;
const DIFFICULTIES = ["easier", "standard", "harder"] as const;

export type UnderstandingPreferences = {
  autoSuggest: boolean;
  pushWarning: boolean;
  questionCount: number;
  difficulty: (typeof DIFFICULTIES)[number];
};

const DEFAULT_UNDERSTANDING_PREFERENCES: UnderstandingPreferences = {
  autoSuggest: false,
  pushWarning: false,
  questionCount: 5,
  difficulty: "standard",
};

export class InvalidUnderstandingPreferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUnderstandingPreferenceError";
  }
}

export class UnderstandingPreferenceConflictError extends Error {
  constructor() {
    super("These preferences changed in another tab or device. Reload and try again.");
    this.name = "UnderstandingPreferenceConflictError";
  }
}

export async function getUnderstandingPreferences(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
): Promise<UnderstandingPreferences & { version: number }> {
  const [row] = await db
    .select()
    .from(understandingPreferences)
    .where(
      and(eq(understandingPreferences.workspaceId, auth.workspaceId), eq(understandingPreferences.userId, auth.userId)),
    )
    .limit(1);
  if (!row) return { ...DEFAULT_UNDERSTANDING_PREFERENCES, version: 0 };
  return {
    autoSuggest: row.autoSuggest,
    pushWarning: row.pushWarning,
    questionCount: row.questionCount,
    difficulty: row.difficulty,
    version: row.version,
  };
}

function validated(input: UnderstandingPreferences): UnderstandingPreferences {
  if (!(QUESTION_COUNTS as readonly number[]).includes(input.questionCount)) {
    throw new InvalidUnderstandingPreferenceError("Choose between 5 and 10 questions.");
  }
  if (!(DIFFICULTIES as readonly string[]).includes(input.difficulty)) {
    throw new InvalidUnderstandingPreferenceError("Difficulty must be easier, standard or harder.");
  }
  return {
    autoSuggest: input.autoSuggest === true,
    pushWarning: input.pushWarning === true,
    questionCount: input.questionCount,
    difficulty: input.difficulty,
  };
}

/** Saves all four switches at once. `expectedVersion` 0 means the person has never saved. */
export async function saveUnderstandingPreferences(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: UnderstandingPreferences & { expectedVersion: number },
): Promise<UnderstandingPreferences & { version: number }> {
  const values = validated(input);
  if (input.expectedVersion === 0) {
    const [created] = await db
      .insert(understandingPreferences)
      .values({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        ...values,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [understandingPreferences.workspaceId, understandingPreferences.userId] })
      .returning({ version: understandingPreferences.version });
    if (!created) throw new UnderstandingPreferenceConflictError();
    return { ...values, version: created.version };
  }
  const [updated] = await db
    .update(understandingPreferences)
    .set({ ...values, updatedBy: auth.userId, updatedAt: new Date(), version: input.expectedVersion + 1 })
    .where(
      and(
        eq(understandingPreferences.workspaceId, auth.workspaceId),
        eq(understandingPreferences.userId, auth.userId),
        eq(understandingPreferences.version, input.expectedVersion),
      ),
    )
    .returning({ version: understandingPreferences.version });
  if (!updated) throw new UnderstandingPreferenceConflictError();
  return { ...values, version: updated.version };
}
