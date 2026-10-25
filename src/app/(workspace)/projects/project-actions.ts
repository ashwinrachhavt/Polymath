"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createProject, setProjectPinned, updateProject } from "@/domains/knowledge/projects";
import {
  addMemory,
  createAutomation,
  deleteAutomation,
  deleteMemory,
  setProjectAccount,
  updateAutomation,
} from "@/domains/knowledge/project-settings";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Project mutations: create, pin, and the settings the right rail and the
 * settings modal own - instructions, description, automations, memory, and
 * the connector allowlist. All writes are member-or-above; each takes an
 * idempotency key so a double-submit is safe.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const revalidateProjects = () => revalidatePath("/projects");
const revalidateProject = (id: string) => {
  revalidateProjects();
  revalidatePath(`/projects/${id}`);
};

const uuid = z.string().uuid();

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createProjectAction(input: { name: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await authorize();
  const parsed = z.object({ name: z.string().trim().min(1).max(200) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the project a name of up to 200 characters." };
  try {
    const project = await createProject(auth, { name: parsed.data.name });
    revalidateProjects();
    return { ok: true, id: project.id };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The project could not be created." };
  }
}

export async function setProjectPinnedAction(input: { projectId: string; pinned: boolean }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z.object({ projectId: uuid, pinned: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That project could not be updated." };
  try {
    await setProjectPinned(auth, parsed.data);
    revalidateProjects();
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The project could not be updated." };
  }
}

export async function updateProjectAction(input: {
  projectId: string;
  title?: string;
  description?: string;
  instructions?: string;
  emoji?: string;
}): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z
    .object({
      projectId: uuid,
      title: z.string().trim().max(200).optional(),
      description: z.string().max(2000).optional(),
      instructions: z.string().max(8000).optional(),
      emoji: z.string().trim().max(8).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the fields and try again." };
  try {
    await updateProject(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The project could not be updated." };
  }
}

export async function createAutomationAction(input: { projectId: string; prompt: string; schedule: string }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z
    .object({ projectId: uuid, prompt: z.string().min(1).max(4000), schedule: z.string().min(1).max(100) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the automation a prompt and a cron schedule." };
  try {
    await createAutomation(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The automation could not be created." };
  }
}

export async function updateAutomationAction(input: { projectId: string; automationId: string; enabled: boolean }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z.object({ projectId: uuid, automationId: uuid, enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That automation could not be updated." };
  try {
    await updateAutomation(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The automation could not be updated." };
  }
}

export async function deleteAutomationAction(input: { projectId: string; automationId: string }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z.object({ projectId: uuid, automationId: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That automation could not be deleted." };
  try {
    await deleteAutomation(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The automation could not be deleted." };
  }
}

export async function addMemoryAction(input: { projectId: string; content: string }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z.object({ projectId: uuid, content: z.string().min(1).max(2000) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Keep a memory under 2000 characters." };
  try {
    await addMemory(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The memory could not be added." };
  }
}

export async function deleteMemoryAction(input: { projectId: string; memoryId: string }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z.object({ projectId: uuid, memoryId: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That memory could not be deleted." };
  try {
    await deleteMemory(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The memory could not be deleted." };
  }
}

export async function setProjectAccountAction(input: { projectId: string; gatewayAccountId: string; enabled: boolean }): Promise<ActionResult> {
  const auth = await authorize();
  const parsed = z.object({ projectId: uuid, gatewayAccountId: uuid, enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That connector could not be updated." };
  try {
    await setProjectAccount(auth, parsed.data);
    revalidateProject(parsed.data.projectId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "The connector could not be updated." };
  }
}
