import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { submitGenerationJob } from "@/domains/jobs/commands";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure } from "@/domains/jobs/state";
import { createMission, MissionError, prepareMissionConcepts } from "./missions";

/*
 * A Mission's concept list as a generation job: submitting a Mission returns
 * at once with a job, the model runs afterwards, and the Mission page shows
 * the wait and its retry through the shared job row - the same shape Learn
 * uses for a quiz, not a second queue.
 */

export const MISSION_JOB_KIND = "learning.mission";

const inputSchema = z.object({
  missionId: z.uuid(),
  goal: z.string().min(1).max(500),
  role: z.string().max(2000).nullable(),
  documentIds: z.array(z.uuid()).min(1).max(8),
});

type MissionJobInput = z.infer<typeof inputSchema>;

export const missionJobSubject = (missionId: string) => `mission:${missionId}`;

/**
 * Accepts a Mission to be planned, and returns at once. The Mission row and
 * its source snapshot commit in the same transaction as the job; a repeated
 * request key returns the first job, never a second.
 */
export async function acceptMissionJob(
  auth: AuthContext,
  request: Omit<MissionJobInput, "missionId"> & { idempotencyKey: string; dueOn: string | null },
): Promise<{ jobId: string; missionId: string; created: boolean }> {
  const mission = await createMission(auth, {
    goal: request.goal,
    role: request.role,
    dueOn: request.dueOn,
    documentIds: request.documentIds,
    requestKey: request.idempotencyKey,
  });
  // A new Mission gets its job; a replayed submit returns the first Mission
  // and the caller starts nothing twice.
  const { job, created } = await submitGenerationJob(auth, {
    kind: MISSION_JOB_KIND,
    subject: missionJobSubject(mission.missionId),
    idempotencyKey: request.idempotencyKey,
    title: request.goal.slice(0, 120),
    input: { missionId: mission.missionId, goal: request.goal, role: request.role, documentIds: request.documentIds },
  });
  return { jobId: job.id, missionId: mission.missionId, created: created && mission.created };
}

function parse(input: unknown): MissionJobInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("malformed mission job input");
  return parsed.data;
}

const makeMissionConcepts: GenerationJobRunner = async (auth, raw) => {
  const input = parse(raw);
  try {
    const { conceptCount } = await prepareMissionConcepts(auth, input.missionId);
    return {
      href: `/learn/missions/${input.missionId}`,
      notice:
        conceptCount === 1 ? "Your concept is ready to review." : `Your ${conceptCount} concepts are ready to review.`,
    };
  } catch (cause) {
    if (cause instanceof MissionError) throw new GenerationJobFailure(cause.message);
    throw cause;
  }
};

export const missionJobRunners: Record<string, GenerationJobRunner> = {
  [MISSION_JOB_KIND]: makeMissionConcepts,
};
