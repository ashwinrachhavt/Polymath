import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { listRecentlyCompletedTasks, listOpenTasks, searchTasksForLink } from "../../../../src/domains/work/queries";
import { listNotes } from "../../../../src/domains/knowledge/notes";

/*
 * ASH-306: conversational navigation. "Show me my open tasks" and "open the
 * note about X" are navigation requests phrased as chat, and answering them in
 * prose is what made the old surface feel like a search box.
 *
 * The tool returns records the thread renders as cards, each carrying its real
 * route, so the answer is the thing itself: a list of tasks you can open, not a
 * description of a list. It is a read over records another domain owns — the
 * domain's own query does the work, and nothing here writes.
 */
export default defineTool({
  description:
    "Find records the owner asked to see: their open or completed tasks, or their notes. Use when they say show me, open, find, or list something — a navigation request, not a question about content. Returns the records themselves with their ids and kinds, which the interface renders as openable cards. For a question about what something SAYS, use documents_search instead; this lists what exists, it does not read it.",
  inputSchema: z.object({
    what: z.enum(["tasks", "completed_tasks", "notes"]).describe("Which records to list."),
    query: z
      .string()
      .max(200)
      .optional()
      .describe("Narrow to records whose title matches, e.g. 'lease'. Omit to list the most relevant or recent."),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    // Task listings need tasks.read; notes need the knowledge read. Checking
    // the capability the call actually uses keeps a task-only grant from
    // silently listing notes.
    const needed = input.what === "notes" ? "records.browse" : "tasks.read";
    if (!toolAllowed(run.policySnapshot, needed)) {
      return { ok: false as const, error: `${needed} is not in this run's policy snapshot` };
    }

    const auth = { workspaceId, userId: current.principalId } as Parameters<typeof listNotes>[0];
    const limit = input.limit ?? 10;
    const query = input.query?.trim();

    if (input.what === "notes") {
      // A title match is a navigation request: "open the note about the lease"
      // should not return a note about something else that ranks well.
      const notes = await listNotes(auth, 100);
      const matched = query ? notes.filter((note) => note.title.toLowerCase().includes(query.toLowerCase())) : notes;
      return {
        ok: true as const,
        kind: "note" as const,
        query: query ?? null,
        total: matched.length,
        records: matched.slice(0, limit).map((note) => ({ kind: "note" as const, id: note.id, title: note.title })),
      };
    }

    if (input.what === "completed_tasks") {
      const done = await listRecentlyCompletedTasks(auth, { limit });
      return {
        ok: true as const,
        kind: "task" as const,
        query: null,
        total: done.length,
        records: done.map((task) => ({ kind: "task" as const, id: task.id, title: task.title, subtitle: "Done" })),
      };
    }

    // Open tasks: a query narrows by title, otherwise the ranked open list.
    if (query) {
      const hits = await searchTasksForLink(auth, query, limit);
      return {
        ok: true as const,
        kind: "task" as const,
        query,
        total: hits.length,
        records: hits.map((task) => ({ kind: "task" as const, id: task.id, title: task.title })),
      };
    }
    const open = await listOpenTasks(auth, limit);
    return {
      ok: true as const,
      kind: "task" as const,
      query: null,
      total: open.length,
      records: open.map((task) => ({
        kind: "task" as const,
        id: task.id,
        title: task.title,
        ...(task.dueAt ? { subtitle: `Due ${new Date(task.dueAt).toISOString().slice(0, 10)}` } : { subtitle: task.status }),
      })),
    };
  },
});
