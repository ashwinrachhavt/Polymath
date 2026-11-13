"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dismissRunCritique } from "@/domains/agents/run-reviews";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Run-level review action (ASH-304): dismissal of the run's self-critique. The
 * operator's verdict on a run is a rating (components/feedback). Domain functions own the state
 * change and the audit row in one transaction; these actions own auth,
 * parsing and the page refresh.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const runId = z.string().uuid();

export async function dismissRunCritiqueAction(input: {
  runId: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean }> {
  const auth = await authorize();
  const parsed = z.object({ runId, idempotencyKey: z.string().max(200).optional() }).parse(input);
  const result = await dismissRunCritique(auth, parsed);
  if (result.ok) revalidatePath(`/polymath/${parsed.runId}`);
  return result;
}
