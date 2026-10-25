import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { projectAccounts, projectAutomations, projectMemories, projects } from "./schema";
import { nextCronRun } from "./automation-ticker";

/*
 * Project settings: automations, memory, and the connector allowlist. Every
 * command re-checks the project boundary - a foreign project id is a
 * project_not_found, never a partial write.
 */

export class ProjectSettingsError extends Error {
  constructor(public readonly code: "project_not_found" | "invalid_automation" | "invalid_memory" | "not_found", message: string) {
    super(message);
    this.name = "ProjectSettingsError";
  }
}

async function ownedProject(auth: AuthContext, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, auth.workspaceId), sql`${projects.archivedAt} is null`))
    .limit(1);
  if (!project) throw new ProjectSettingsError("project_not_found", "No such project.");
  return project;
}

/**
 * The context prefix a project-scoped session or automation run is injected
 * with: custom instructions, then memory. One builder, so a session started
 * from the page and one started by the ticker read the same prompt shape.
 */
export function buildProjectContextPrefix(
  project: { title: string; instructions: string | null },
  memories: Array<{ content: string }>,
): string {
  const parts: string[] = [`Project: ${project.title}.`];
  if (project.instructions?.trim()) parts.push(`Project instructions:\n${project.instructions.trim()}`);
  if (memories.length > 0) {
    parts.push(`What this project remembers:\n${memories.map((m) => `- ${m.content}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

// --- Automations ---

export async function listAutomations(auth: AuthContext, projectId: string) {
  await ownedProject(auth, projectId);
  return db
    .select()
    .from(projectAutomations)
    .where(and(eq(projectAutomations.workspaceId, auth.workspaceId), eq(projectAutomations.projectId, projectId), isNull(projectAutomations.archivedAt)))
    .orderBy(asc(projectAutomations.createdAt));
}

export async function createAutomation(
  auth: AuthContext,
  input: { projectId: string; prompt: string; schedule: string },
) {
  await ownedProject(auth, input.projectId);
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4000) throw new ProjectSettingsError("invalid_automation", "Give the automation a prompt of up to 4000 characters.");
  const schedule = input.schedule.trim();
  // nextCronRun is the one validation: a five-field cron with a computable
  // next slot. The first slot is set here, so the ticker only ever fires rows
  // it finds due.
  const first = nextCronRun(schedule, new Date());
  if (!first) throw new ProjectSettingsError("invalid_automation", "Use a five-field cron expression, like 0 8 * * *.");
  const [row] = await db
    .insert(projectAutomations)
    .values({ workspaceId: auth.workspaceId, projectId: input.projectId, prompt, schedule, nextRunAt: first, createdBy: auth.userId, updatedBy: auth.userId })
    .returning();
  return row;
}

export async function updateAutomation(
  auth: AuthContext,
  input: { projectId: string; automationId: string; enabled?: boolean; prompt?: string; schedule?: string },
) {
  await ownedProject(auth, input.projectId);
  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: auth.userId, version: sql`${projectAutomations.version} + 1` };
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.prompt !== undefined) patch.prompt = input.prompt.trim();
  if (input.schedule !== undefined) patch.schedule = input.schedule.trim();
  const [row] = await db
    .update(projectAutomations)
    .set(patch)
    .where(
      and(
        eq(projectAutomations.id, input.automationId),
        eq(projectAutomations.projectId, input.projectId),
        eq(projectAutomations.workspaceId, auth.workspaceId),
        isNull(projectAutomations.archivedAt),
      ),
    )
    .returning();
  if (!row) throw new ProjectSettingsError("not_found", "No such automation.");
  return row;
}

export async function deleteAutomation(auth: AuthContext, input: { projectId: string; automationId: string }) {
  await ownedProject(auth, input.projectId);
  const [row] = await db
    .update(projectAutomations)
    .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: auth.userId, version: sql`${projectAutomations.version} + 1` })
    .where(
      and(
        eq(projectAutomations.id, input.automationId),
        eq(projectAutomations.projectId, input.projectId),
        eq(projectAutomations.workspaceId, auth.workspaceId),
      ),
    )
    .returning({ id: projectAutomations.id });
  if (!row) throw new ProjectSettingsError("not_found", "No such automation.");
  return row;
}

// --- Memory ---

export async function listMemories(auth: AuthContext, projectId: string) {
  await ownedProject(auth, projectId);
  return db
    .select()
    .from(projectMemories)
    .where(and(eq(projectMemories.workspaceId, auth.workspaceId), eq(projectMemories.projectId, projectId), isNull(projectMemories.archivedAt)))
    .orderBy(desc(projectMemories.createdAt));
}

export async function addMemory(auth: AuthContext, input: { projectId: string; content: string }) {
  await ownedProject(auth, input.projectId);
  const content = input.content.trim();
  if (!content || content.length > 2000) throw new ProjectSettingsError("invalid_memory", "Keep a memory under 2000 characters.");
  const [row] = await db
    .insert(projectMemories)
    .values({ workspaceId: auth.workspaceId, projectId: input.projectId, content, createdBy: auth.userId, updatedBy: auth.userId })
    .returning();
  return row;
}

export async function deleteMemory(auth: AuthContext, input: { projectId: string; memoryId: string }) {
  await ownedProject(auth, input.projectId);
  const [row] = await db
    .update(projectMemories)
    .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: auth.userId, version: sql`${projectMemories.version} + 1` })
    .where(and(eq(projectMemories.id, input.memoryId), eq(projectMemories.projectId, input.projectId), eq(projectMemories.workspaceId, auth.workspaceId)))
    .returning({ id: projectMemories.id });
  if (!row) throw new ProjectSettingsError("not_found", "No such memory.");
  return row;
}

// --- Connector allowlist ---

export async function listProjectAccounts(auth: AuthContext, projectId: string) {
  await ownedProject(auth, projectId);
  return db
    .select({ id: projectAccounts.id, gatewayAccountId: projectAccounts.gatewayAccountId, enabled: projectAccounts.enabled })
    .from(projectAccounts)
    .where(and(eq(projectAccounts.workspaceId, auth.workspaceId), eq(projectAccounts.projectId, projectId)));
}

export async function setProjectAccount(auth: AuthContext, input: { projectId: string; gatewayAccountId: string; enabled: boolean }) {
  await ownedProject(auth, input.projectId);
  await db
    .insert(projectAccounts)
    .values({ workspaceId: auth.workspaceId, projectId: input.projectId, gatewayAccountId: input.gatewayAccountId, enabled: input.enabled })
    .onConflictDoUpdate({
      target: [projectAccounts.projectId, projectAccounts.gatewayAccountId],
      set: { enabled: input.enabled },
    });
}

/** Enabled account ids for a project, or null when no allowlist exists (all accounts allowed). */
export async function projectAccountAllowlist(auth: AuthContext, projectId: string): Promise<string[] | null> {
  const rows = await db
    .select({ gatewayAccountId: projectAccounts.gatewayAccountId, enabled: projectAccounts.enabled })
    .from(projectAccounts)
    .where(and(eq(projectAccounts.workspaceId, auth.workspaceId), eq(projectAccounts.projectId, projectId)));
  if (rows.length === 0) return null;
  return rows.filter((r) => r.enabled).map((r) => r.gatewayAccountId);
}

