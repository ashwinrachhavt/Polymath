"use server";

import { getPreferences } from "@/domains/identity/preferences";
import { getKnowledgeDebt, type KnowledgeDebt } from "@/domains/knowledge/debt";
import { getWeeklyReview, weekStartFor, type WeeklyReview } from "@/domains/work/reports";
import { getAuthContext } from "@/lib/auth";

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
