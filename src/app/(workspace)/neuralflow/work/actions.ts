"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { completeTask, createOwnerTask } from "@/domains/work/commands";
import { getAuthContext } from "@/lib/auth";

/*
 * Work mutations. Both write the canonical `tasks` row — the same one
 * obligation acceptance writes — which is the whole point: a task created in
 * document review appears here, and completing it here is visible to every
 * other reader of that row.
 */

const revalidate = () => revalidatePath("/neuralflow/work");

const createInput = z.object({
  title: z.string().trim().min(1).max(300),
  dueAt: z.coerce.date().optional(),
  personId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
});

export async function createTaskAction(input: {
  title: string;
  dueAt?: string;
  personId?: string;
  organizationId?: string;
}): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the task a title." };

  const auth = await getAuthContext();
  const { id } = await createOwnerTask(auth, parsed.data);
  revalidate();
  return { ok: true, taskId: id };
}

export async function completeTaskAction(
  taskId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.string().uuid().safeParse(taskId);
  if (!parsed.success) return { ok: false, error: "That task no longer exists." };

  const auth = await getAuthContext();
  const done = await completeTask(auth, { taskId: parsed.data });
  revalidate();
  // Already done leaves the row alone and says so, rather than pretending the
  // second click did something.
  return done
    ? { ok: true }
    : { ok: false, error: "This task was already completed. Reload to see it." };
}
