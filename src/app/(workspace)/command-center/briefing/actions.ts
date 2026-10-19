"use server";

import { revalidatePath, updateTag } from "next/cache";
import { updateTask } from "@/domains/work/task-commands";
import { getAuthContext } from "@/lib/auth";
import { tasksTag } from "@/lib/cache-tags";
import { requireRole } from "@/lib/auth/guards";

/*
 * Outcome decisions (A01). Accepting an outcome tags the canonical task with
 * the workspace-local day; replacing removes the tag. Both are plain
 * version-checked task patches - no scheduling, no model calls.
 */

type Result = { ok: true } | { ok: false; error: string };

async function setOutcomeTag(input: { taskId: string; expectedVersion: number; tags: string[] }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    await updateTask(auth, { taskId: input.taskId, expectedVersion: input.expectedVersion, patch: { tags: input.tags } });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not update the outcome." };
  }
  updateTag(tasksTag(auth));
  revalidatePath("/command-center/briefing");
  return { ok: true };
}

export async function acceptOutcomeAction(input: {
  taskId: string;
  expectedVersion: number;
  tags: string[];
  outcomeTag: string;
}): Promise<Result> {
  if (input.tags.includes(input.outcomeTag)) return { ok: true };
  return setOutcomeTag({ taskId: input.taskId, expectedVersion: input.expectedVersion, tags: [...input.tags, input.outcomeTag] });
}

export async function replaceOutcomeAction(input: {
  taskId: string;
  expectedVersion: number;
  tags: string[];
  outcomeTag: string;
}): Promise<Result> {
  return setOutcomeTag({
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    tags: input.tags.filter((tag) => tag !== input.outcomeTag),
  });
}
