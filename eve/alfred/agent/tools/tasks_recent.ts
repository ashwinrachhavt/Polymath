import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { listRecentlyCompletedTasks } from "../../../../src/domains/work/queries";

/*
 * A read capability over finished work. listOpenTasks answers "what remains";
 * this answers "what got done" — progress questions ("how did my week go")
 * fail closed without it, because the honest read of open work is nothing.
 * The workspace comes from the session's auth attributes, never from the
 * model's arguments.
 */
export default defineTool({
  description:
    "List the workspace's tasks completed in the last N days (default 7), newest first. Use for progress and review questions ('how did my week go', 'what did I finish') — open tasks say nothing about what was done, so tasks_read is the wrong tool for those. It will not show open or upcoming work; pair it with tasks_read when the question covers both done and remaining. Read-only; the run's frozen policy must allow the tasks.read capability.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(90).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, "tasks.read")) {
      return { ok: false as const, error: "tasks.read is not in this run's policy snapshot" };
    }

    const tasks = await listRecentlyCompletedTasks(
      { workspaceId },
      { days: input.days, limit: input.limit },
    );
    // Dates are not JSON-serializable across eve's tool boundary; the run's
    // result row carries jsonb. ISO strings keep the ordering information.
    return {
      ok: true as const,
      tasks: tasks.map((task) => ({ ...task, completedAt: task.completedAt?.toISOString() ?? null })),
      days: input.days ?? 7,
    };
  },
});
