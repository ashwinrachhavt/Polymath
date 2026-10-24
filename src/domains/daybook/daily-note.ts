import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifacts } from "../knowledge/schema";
import { createNote } from "../knowledge/notes";

/*
 * The day's note (eng review T4/R12): a normal note artifact marked with a
 * `daily:<local-date>` tag. No new kind, no pointer table — the day page is a
 * view and the note is one normal record a tag makes findable. The marker
 * tag stays out of the user-facing tag list by convention (tags normalize to
 * lowercase; `daily:` is a reserved prefix).
 */
export const DAILY_TAG_PREFIX = "daily:";

export function dailyTag(localDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error(`Invalid local date: ${localDate}`);
  }
  return `${DAILY_TAG_PREFIX}${localDate}`;
}

/** The same-day note for this user's workspace, or null. */
export async function findDailyNote(
  auth: AuthContext,
  localDate: string,
): Promise<{ id: string; title: string } | null> {
  const tag = dailyTag(localDate);
  const [row] = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        eq(artifacts.kind, "note"),
        sql`${artifacts.tags} @> ${JSON.stringify([tag])}::jsonb`,
        sql`${artifacts.archivedAt} is null`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getOrCreateDailyNote(
  auth: AuthContext,
  input: { localDate: string; idempotencyKey: string },
): Promise<{ id: string; created: boolean }> {
  const existing = await findDailyNote(auth, input.localDate);
  if (existing) return { id: existing.id, created: false };
  const note = await createNote(auth, {
    idempotencyKey: input.idempotencyKey,
    title: input.localDate,
    kind: "note",
  });
  await db
    .update(artifacts)
    .set({ tags: sql`${artifacts.tags} || ${JSON.stringify([dailyTag(input.localDate)])}::jsonb` })
    .where(and(eq(artifacts.id, note.id), eq(artifacts.workspaceId, auth.workspaceId)));
  return { id: note.id, created: true };
}
