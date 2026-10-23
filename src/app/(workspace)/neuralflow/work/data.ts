import { cacheLife, cacheTag } from "next/cache";
import { getActiveFocusSession, listFocusHistory } from "@/domains/focus/queries";
import {
  getTaskDetail,
  listTasksDueBetween,
  listWorkPage,
  listWorkRows,
} from "@/domains/work/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { focusTag, tasksTag } from "@/lib/cache-tags";

/*
 * Cached reads for the Work surfaces (same App Shell rationale as the
 * Briefing wrapper). Task and capture conversions updateTag(tasksTag); focus
 * session writes updateTag(focusTag).
 */
type WorkView = "today" | "open" | "done";

export async function listWorkPageForPage(
  auth: AuthContext,
  view: WorkView,
  input: Parameters<typeof listWorkPage>[2],
) {
  "use cache";
  cacheLife("default");
  cacheTag(tasksTag(auth));
  return listWorkPage(auth, view, input);
}

export async function listWorkRowsForPage(auth: AuthContext, view: WorkView, limit?: number) {
  "use cache";
  cacheLife("default");
  cacheTag(tasksTag(auth));
  return listWorkRows(auth, view, limit);
}

export async function getTaskDetailForPage(auth: AuthContext, taskId: string) {
  "use cache";
  cacheLife("default");
  cacheTag(tasksTag(auth));
  return getTaskDetail(auth, taskId);
}

export async function listTasksDueBetweenForPage(auth: AuthContext, from: string, to: string) {
  "use cache";
  cacheLife("default");
  cacheTag(tasksTag(auth));
  return listTasksDueBetween(auth, from, to);
}

export async function getActiveFocusSessionForPage(auth: AuthContext) {
  "use cache";
  cacheLife("default");
  cacheTag(focusTag(auth));
  return getActiveFocusSession(auth);
}

export async function listFocusHistoryForPage(auth: AuthContext, limit?: number, taskId?: string) {
  "use cache";
  cacheLife("default");
  cacheTag(focusTag(auth));
  return listFocusHistory(auth, limit, taskId);
}
