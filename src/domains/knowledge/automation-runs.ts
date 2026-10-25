import { createEngine } from "@/domains/agents/engine";
import { createEveDriver, eveAgentForProfile, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { ensureProfile } from "@/domains/agents/commands";
import { db } from "@/lib/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { memberships } from "@/domains/identity/schema";
import { notebookMemories, notebooks } from "./schema";
import { buildProjectContextPrefix } from "./project-settings";

/*
 * An automation's run. The ticker calls this with a workspace id, not an
 * AuthContext - the automation acts as its workspace's member - so the system
 * context is resolved here and the spend, subject binding, and policy snapshot
 * all flow through the ordinary engine path.
 *
 * The objective carries the project's instructions and memory, so an
 * automation's output is indistinguishable from a session started inside the
 * project with full context.
 */
export async function startAutomationRun(input: { workspaceId: string; projectId: string; prompt: string }) {
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) throw new Error(unavailable);

  const [project] = await db
    .select({ id: notebooks.id, title: notebooks.title, instructions: notebooks.instructions })
    .from(notebooks)
    .where(and(eq(notebooks.id, input.projectId), eq(notebooks.workspaceId, input.workspaceId), isNull(notebooks.archivedAt)))
    .limit(1);
  if (!project) throw new Error("No such project.");

  const memories = await db
    .select({ content: notebookMemories.content })
    .from(notebookMemories)
    .where(and(eq(notebookMemories.workspaceId, input.workspaceId), eq(notebookMemories.notebookId, input.projectId), isNull(notebookMemories.archivedAt)))
    .orderBy(sql`created_at desc`)
    .limit(50);

  const contextPrefix = buildProjectContextPrefix(project, memories);

  await ensureProfile(input.workspaceId, "alfred");
  // The automation acts as the workspace's owner: the run is attributed to a
  // real user of this workspace, since engine.start needs a principal for the
  // policy snapshot and spend ceiling.
  const [owner] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.role, "owner"), eq(memberships.status, "active")))
    .limit(1);
  if (!owner) throw new Error("The workspace has no owner to act as.");
  const engine = createEngine(createEveDriver(eveAgentForProfile("alfred")));
  const { runId } = await engine.start({
    auth: { userId: owner.userId, workspaceId: input.workspaceId, role: "owner" },
    profileName: "alfred",
    objective: `${contextPrefix}\n\nScheduled task:\n${input.prompt}`,
    subjects: [{ type: "project", id: project.id }],
    estimateUsd: "0.50",
  });
  return { runId };
}
