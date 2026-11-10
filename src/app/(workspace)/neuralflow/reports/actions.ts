"use server";

import { getPreferences } from "@/domains/identity/preferences";
import { getKnowledgeDebt, type KnowledgeDebt } from "@/domains/knowledge/debt";
import { listStonesEarnedInRange } from "@/domains/gamification/queries";
import { createNote } from "@/domains/knowledge/notes";
import { composeOutcomeNarrative, narrativeToNoteContent, type OutcomeNarrative } from "@/domains/work/outcome-narrative";
import { getWeeklyReview, listFinishedSessionsInWeek, weekStartFor, type WeeklyReview } from "@/domains/work/reports";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

export async function loadWeeklyReviewAction(input: { start?: string }): Promise<{ ok: true; review: WeeklyReview } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  try {
    const prefs = await getPreferences(auth);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: prefs.timezone }).format(new Date());
    const start = input.start && /^\d{4}-\d{2}-\d{2}$/.test(input.start) ? input.start : weekStartFor(today, prefs.weekStart);
    return { ok: true, review: await getWeeklyReview(auth, { start, timezone: prefs.timezone }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the weekly review." };
  }
}

export async function loadKnowledgeDebtAction(): Promise<{ ok: true; debt: KnowledgeDebt } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  try {
    return { ok: true, debt: await getKnowledgeDebt(auth) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the knowledge debt report." };
  }
}

/* ASH-280: composed from server rows on every call, so a kept note is never client-supplied text. */
async function composeNarrativeForWeek(auth: AuthContext, requestedStart?: string): Promise<OutcomeNarrative | null> {
  const prefs = await getPreferences(auth);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: prefs.timezone }).format(new Date());
  const start = requestedStart && /^\d{4}-\d{2}-\d{2}$/.test(requestedStart) ? requestedStart : weekStartFor(today, prefs.weekStart);
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const endDate = end.toISOString().slice(0, 10);
  const [sessions, stones] = await Promise.all([
    listFinishedSessionsInWeek(auth, { start, timezone: prefs.timezone }),
    listStonesEarnedInRange(auth, { start, end: endDate, timezone: prefs.timezone }),
  ]);
  return composeOutcomeNarrative({ start, end: endDate, sessions, stones });
}

export async function loadOutcomeNarrativeAction(input: { start?: string }): Promise<{ ok: true; narrative: OutcomeNarrative | null } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  try {
    return { ok: true, narrative: await composeNarrativeForWeek(auth, input.start) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the weekly narrative." };
  }
}

/* Keep is the only write, and only on an explicit click: the narrative becomes a plain note. Discard writes nothing. */
export async function keepOutcomeNarrativeAction(input: { start?: string; idempotencyKey: string }): Promise<{ ok: true; artifactId: string } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const narrative = await composeNarrativeForWeek(auth, input.start);
    if (!narrative) return { ok: false, error: "There is nothing recorded for that week to keep." };
    const note = await createNote(auth, { idempotencyKey: input.idempotencyKey, title: narrative.title, content: narrativeToNoteContent(narrative), plainText: narrative.plainText });
    return { ok: true, artifactId: note.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the narrative as a note." };
  }
}
