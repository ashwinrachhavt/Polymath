"use server";

import { bugReportInput, signalFromReport } from "@/domains/bug-triage/signal";
import { recordBugSignal } from "@/domains/bug-triage/store";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import type { Result } from "@/lib/result";

/*
 * The header's "Report a bug". Signed-in members only. The report carries the
 * route, the last error id and a kind from a fixed list - never page content,
 * never who reported it - so the recorded signal is safe to publish once
 * scrubbed. The outbox worker files it.
 */
export async function reportBugAction(input: unknown): Promise<Result> {
  try {
    await getAuthContext();
  } catch (error) {
    return { ok: false, error: actionError(error, "Sign in to report a bug.") };
  }
  const parsed = bugReportInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That report could not be read." };
  try {
    await recordBugSignal(signalFromReport(parsed.data));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not send the report. Try again.") };
  }
}
