"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dismissRunCritique, setRunFeedback } from "@/domains/agents/run-reviews";
import { FEEDBACK_REASONS } from "@/domains/agents/schema";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Run-level review actions (ASH-304): the operator's verdict on a finished run
 * and dismissal of the run's self-critique. Domain functions own the state
 * change and the audit row in one transaction; these actions own auth,
 * parsing and the page refresh.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const runId = z.string().uuid();

export async function setRunFeedbackAction(input: {
  runId: string;
  verdict: "up" | "down" | "clear";
  reasons?: string[];
  note?: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; verdict: "up" | "down" | null }> {
  const auth = await authorize();
  const parsed = z
    .object({
      runId,
      verdict: z.enum(["up", "down", "clear"]),
      reasons: z.array(z.enum(FEEDBACK_REASONS)).max(6).optional(),
      note: z.string().max(280).optional(),
      idempotencyKey: z.string().max(200).optional(),
    })
    .parse(input);
  const result = await setRunFeedback(auth, parsed);
  if (result.ok) revalidatePath(`/alfred/${parsed.runId}`);
  return result;
}

export async function dismissRunCritiqueAction(input: {
  runId: string;
  idempotencyKey?: string;
}): Promise<{ ok: boolean }> {
  const auth = await authorize();
  const parsed = z.object({ runId, idempotencyKey: z.string().max(200).optional() }).parse(input);
  const result = await dismissRunCritique(auth, parsed);
  if (result.ok) revalidatePath(`/alfred/${parsed.runId}`);
  return result;
}
