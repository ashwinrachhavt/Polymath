"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { IdempotencyConflictError } from "@/domains/audit/receipt";
import { completeTask, createOwnerTask } from "@/domains/work/commands";
import {
  DependencyCycleError,
  RankOrderError,
  SubtaskDepthError,
  TaskNotFoundError,
  VersionConflictError,
  addDependency,
  createSubtask,
  moveTask,
  removeDependency,
  updateTask,
} from "@/domains/work/task-commands";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { tasksTag } from "@/lib/cache-tags";

/*
 * Work mutations. Both write the canonical `tasks` row — the same one
 * obligation acceptance writes — which is the whole point: a task created in
 * document review appears here, and completing it here is visible to every
 * other reader of that row.
 */

const revalidate = (auth: AuthContext) => {
  updateTag(tasksTag(auth));
  revalidatePath("/neuralflow/work");
};

/*
 * Every action below writes the canonical tasks row, so each requires member
 * or above - a viewer's quick complete is still a write (ASH-121 AC05).
 */
async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const createInput = z.object({
  title: z.string().trim().min(1).max(300),
  dueAt: z.coerce.date().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  estimateMinutes: z.number().int().min(1).max(1440).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  personId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid().optional(),
});

export async function createTaskAction(input: {
  title: string;
  dueAt?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  estimateMinutes?: number;
  tags?: string[];
  personId?: string;
  organizationId?: string;
  idempotencyKey?: string;
}): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the task a title." };

  const auth = await authorize();
  const { id } = await createOwnerTask(auth, parsed.data);
  revalidate(auth);
  return { ok: true, taskId: id };
}

export async function completeTaskAction(
  taskId: string,
): Promise<{ ok: true; quartzEarned: boolean } | { ok: false; error: string }> {
  const parsed = z.string().uuid().safeParse(taskId);
  if (!parsed.success) return { ok: false, error: "That task no longer exists." };

  const auth = await authorize();
  const done = await completeTask(auth, { taskId: parsed.data });
  revalidate(auth);
  // Already done leaves the row alone and says so, rather than pretending the
  // second click did something.
  return done
    ? { ok: true, quartzEarned: done.quartzEarned }
    : { ok: false, error: "This task was already completed. Reload to see it." };
}

/*
 * Task-graph mutations (A03). Each takes the idempotency key the client minted
 * for this user intent and the version it last saw; a stale version or a
 * dependency cycle comes back as a message, not a thrown error.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const domainErrors = [
  TaskNotFoundError,
  VersionConflictError,
  DependencyCycleError,
  SubtaskDepthError,
  RankOrderError,
  IdempotencyConflictError,
];

async function guarded<T extends object>(auth: AuthContext, run: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await run();
    revalidate(auth);
    return { ok: true, ...value };
  } catch (error) {
    if (domainErrors.some((E) => error instanceof E)) return { ok: false, error: (error as Error).message };
    throw error;
  }
}

const key = z.string().uuid();
const id = z.string().uuid();

const patchInput = z.object({
  taskId: id,
  expectedVersion: z.number().int().min(1),
  idempotencyKey: key,
  patch: z
    .object({
      title: z.string().trim().min(1).max(300),
      description: z.string().max(20_000).nullable(),
      status: z.enum(["inbox", "backlog", "ready", "in_progress", "waiting", "done", "cancelled"]),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]),
      dueAt: z.string().datetime().nullable(),
      estimateMinutes: z.number().int().min(0).max(100_000).nullable(),
      tags: z.array(z.string().trim().min(1).max(60)).max(30),
    })
    .partial()
    .refine((p) => Object.keys(p).length > 0, "Nothing to change."),
});

export async function updateTaskAction(input: z.input<typeof patchInput>): Promise<Result<{ version: number }>> {
  const parsed = patchInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the task fields and try again." };
  const auth = await authorize();
  return guarded(auth, async () => ({ version: (await updateTask(auth, parsed.data)).version }));

}

const subtaskInput = z.object({ parentTaskId: id, title: z.string().trim().min(1).max(300), idempotencyKey: key });

export async function createSubtaskAction(input: z.input<typeof subtaskInput>): Promise<Result<{ taskId: string }>> {
  const parsed = subtaskInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the subtask a title." };
  const auth = await authorize();
  return guarded(auth, async () => ({ taskId: (await createSubtask(auth, parsed.data)).id }));

}

const moveInput = z.object({
  taskId: id,
  expectedVersion: z.number().int().min(1),
  afterTaskId: id.optional(),
  beforeTaskId: id.optional(),
  idempotencyKey: key,
});

export async function moveTaskAction(input: z.input<typeof moveInput>): Promise<Result<{ rank: string; version: number }>> {
  const parsed = moveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That move is not valid." };
  const auth = await authorize();
  return guarded(auth, async () => {

    const { rank, version } = await moveTask(auth, parsed.data);
    return { rank, version };
  });
}

const dependencyInput = z.object({
  taskId: id,
  otherTaskId: id,
  kind: z.enum(["blocks", "blocked_by"]),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: key,
});

export async function addDependencyAction(input: z.input<typeof dependencyInput>): Promise<Result<{ dependencyId: string }>> {
  const parsed = dependencyInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That dependency is not valid." };
  const auth = await authorize();
  return guarded(auth, async () => ({ dependencyId: (await addDependency(auth, parsed.data)).id }));

}

export async function removeDependencyAction(input: { dependencyId: string; idempotencyKey: string }): Promise<Result> {
  const parsed = z.object({ dependencyId: id, idempotencyKey: key }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That dependency no longer exists." };
  const auth = await authorize();
  return guarded(auth, async () => {

    await removeDependency(auth, parsed.data);
    return {};
  });
}
