"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { checkCaptureSource, documentForCapture } from "@/domains/capture/document-source";
import { ConflictError, StaleWriteError } from "@/domains/capture/commands";
import { GenerationJobConflictError } from "@/domains/jobs/commands";
import { kickGenerationJob } from "@/domains/jobs/kick";

import { acceptMissionJob } from "@/domains/learning/mission-jobs";
import {
  MissionError,
  setMissionConcepts,
  startMission,
  updateMissionDueDate,
  type MissionView,
} from "@/domains/learning/missions";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The Mission entry's mutations. Each is member-only, returns a typed union,
 * and maps the domain's codes onto authored copy. Submitting returns at once
 * with the background job; the page shows the wait and the plan forms itself.
 */

export type MissionSourceRef = { type: "document"; id: string } | { type: "capture"; id: string; version: number };

const createSchema = z.object({
  goal: z.string().trim().min(1).max(500),
  role: z.string().max(2000).optional(),
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  sources: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("document"), id: z.uuid() }),
        z.object({ type: z.literal("capture"), id: z.uuid(), version: z.number().int().min(0) }),
      ]),
    )
    .min(1)
    .max(20),
  idempotencyKey: z.uuid(),
});

export async function createMissionAction(
  input: z.input<typeof createSchema>,
): Promise<{ ok: true; jobId: string; missionId: string } | { ok: false; error: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Write one sentence for what you need to be able to do." };
  const { goal, role, dueOn, sources, idempotencyKey } = parsed.data;
  try {
    const auth = await authorize();
    const documentIds = await resolveDocuments(auth, sources);
    const result = await acceptMissionJob(auth, {
      goal,
      role: role?.trim() || null,
      dueOn: dueOn ?? null,
      documentIds,
      idempotencyKey,
    });
    // The job writes concepts; the date is the owner's, written once when the
    // Mission is first made.
    if (result.created) {
      if (dueOn) await updateMissionDueDate(auth, result.missionId, dueOn);
      kickGenerationJob({ jobId: result.jobId, attempt: 1 });
    }
    revalidatePath("/learn");
    return { ok: true, missionId: result.missionId, jobId: result.jobId };
  } catch (error) {
    if (error instanceof MissionError) return { ok: false, error: error.message };
    if (error instanceof QuizSourceError) return { ok: false, error: error.message };
    if (error instanceof GenerationJobConflictError) {
      return { ok: false, error: "That request changed while it was being sent. Try again." };
    }
    return { ok: false, error: actionError(error, "Could not start this Mission.") };
  }
}

/** A capture that cannot be a source, named so the form can point at it. */
class QuizSourceError extends Error {}

async function resolveDocuments(
  auth: Awaited<ReturnType<typeof authorize>>,
  sources: MissionSourceRef[],
): Promise<string[]> {
  const documentIds: string[] = [];
  for (const source of sources) {
    if (source.type === "document") {
      if (!documentIds.includes(source.id)) documentIds.push(source.id);
      continue;
    }
    try {
      const { documentId } = await checkCaptureSource(auth, { captureId: source.id, expectedVersion: source.version });
      // A capture not yet filed has no document yet; the filing pass below gives it one.
      if (documentId && !documentIds.includes(documentId)) documentIds.push(documentId);
      continue;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof StaleWriteError) throw new QuizSourceError(error.message);
      throw error;
    }
  }
  // A capture chosen but not yet filed is filed now, because learning reads documents.
  for (const source of sources) {
    if (source.type !== "capture") continue;
    try {
      const documentId = await documentForCapture(auth, { captureId: source.id, expectedVersion: source.version });
      if (!documentIds.includes(documentId)) documentIds.push(documentId);
    } catch (error) {
      if (error instanceof ConflictError || error instanceof StaleWriteError) throw new QuizSourceError(error.message);
      throw error;
    }
  }
  return documentIds;
}

const planSchema = z.object({
  missionId: z.uuid(),
  keepConceptIds: z.array(z.uuid()).max(20),
  added: z.array(z.object({ name: z.string().trim().min(1).max(80), reason: z.string().max(240).optional() })).max(20),
});

export async function setMissionPlanAction(
  input: z.input<typeof planSchema>,
): Promise<{ ok: true; mission: MissionView } | { ok: false; error: string }> {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Keep or add at least one concept, each with a short name." };
  try {
    const auth = await authorize();
    const mission = await setMissionConcepts(auth, parsed.data.missionId, {
      keepConceptIds: parsed.data.keepConceptIds,
      added: parsed.data.added,
    });
    revalidatePath(`/learn/missions/${parsed.data.missionId}`);
    return { ok: true, mission };
  } catch (error) {
    if (error instanceof MissionError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not save the plan.") };
  }
}

export async function startMissionAction(
  missionId: string,
): Promise<{ ok: true; mission: MissionView } | { ok: false; error: string }> {
  if (!z.uuid().safeParse(missionId).success) return { ok: false, error: "That Mission is not available." };
  try {
    const auth = await authorize();
    const mission = await startMission(auth, missionId);
    revalidatePath("/learn");
    revalidatePath(`/learn/missions/${missionId}`);
    return { ok: true, mission };
  } catch (error) {
    if (error instanceof MissionError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not start this Mission.") };
  }
}

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}
