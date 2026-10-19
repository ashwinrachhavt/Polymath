"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import {
  abandonFocusSession,
  ConflictError,
  finishFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  StaleWriteError,
  startFocusSession,
} from "@/domains/focus/commands";
import { getAuthContext } from "@/lib/auth";
import type { AuthContext } from "@/domains/identity/resolve";
import { focusTag } from "@/lib/cache-tags";
import { requireRole } from "@/lib/auth/guards";

/*
 * Focus lifecycle actions. Every transition carries the version the caller
 * rendered; a stale version is a user-safe error, never a silent overwrite.
 * The server owns the clock - clients send intents, not timestamps.
 */

const revalidate = (auth: AuthContext) => {
  updateTag(focusTag(auth));
  revalidatePath("/neuralflow/focus");
};

type Result = { ok: true } | { ok: false; error: string };

function fail(error: unknown): Result {
  if (error instanceof StaleWriteError || error instanceof ConflictError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const transitionInput = z.object({
  sessionId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().max(200).optional().default(""),
  outcome: z.string().trim().max(500).optional().default(""),
  whatChanged: z.string().trim().max(500).optional().default(""),
  nextStep: z.string().trim().max(500).optional().default(""),
});

export async function startSessionAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      subject: z.string().trim().max(200).optional().default(""),
      plannedMinutes: z.number().int().min(1).max(480).nullable(),
      taskId: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the session and try again." };
  }
  if (!parsed.data.taskId && !parsed.data.subject) {
    return { ok: false, error: "Name what you are focusing on." };
  }
  const auth = await authorize();
  try {
    await startFocusSession(auth, {
      subject: parsed.data.subject || null,
      plannedMinutes: parsed.data.plannedMinutes,
      taskId: parsed.data.taskId ?? null,
    });
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

export async function pauseSessionAction(input: unknown): Promise<Result> {
  const parsed = transitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await pauseFocusSession(auth, { ...parsed.data, reason: parsed.data.reason || null });
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

export async function resumeSessionAction(input: unknown): Promise<Result> {
  const parsed = transitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await resumeFocusSession(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

export async function finishSessionAction(input: unknown): Promise<Result> {
  const parsed = transitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await finishFocusSession(auth, { ...parsed.data, outcome: parsed.data.outcome || null, whatChanged: parsed.data.whatChanged || null, nextStep: parsed.data.nextStep || null });
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}

export async function abandonSessionAction(input: unknown): Promise<Result> {
  const parsed = transitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await abandonFocusSession(auth, { ...parsed.data, reason: parsed.data.reason || null });
  } catch (error) {
    return fail(error);
  }
  revalidate(auth);
  return { ok: true };
}
