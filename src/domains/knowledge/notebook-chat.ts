import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { agentRuns, toolCalls } from "@/domains/agents/schema";
import { listThreads } from "@/domains/agents/thread";
import { citationsFromToolOutput } from "@/domains/agents/stream-contract";
import type { DocumentCitation } from "./agent-search";

/*
 * A notebook's grounded conversation (NotebookLM parity, ASH-179).
 *
 * The conversation is a run bound to the dossier, exactly like a Studio
 * Generate run, so one marker has to tell them apart: the objective prefix
 * below. It is a constant rather than a shape change because agent_runs has
 * no kind column and the prefix already names the contract to the model. Two
 * readers depend on it never drifting: listNotebookChats (the pane's history
 * and resume) and the Studio Runs panel (it excludes chats). The integration
 * suite pins the classification so an edit to the wording breaks loudly, not
 * silently.
 *
 * The prefix contains no LIKE wildcards (% or _), so the pattern is the
 * literal prefix.
 */

export const NOTEBOOK_CHAT_OBJECTIVE_PREFIX = 'Answer questions using only the sources in the notebook "';

/** The chat run's objective: the grounding instruction the model sees. */
export function notebookChatObjective(title: string): string {
  return `${NOTEBOOK_CHAT_OBJECTIVE_PREFIX}${title}". Cite the sources you use. If the notebook does not contain the answer, say so.`;
}

/** Whether a run objective names a notebook chat (vs a Studio Generate run). */
export function isNotebookChatObjective(objective: string): boolean {
  return objective.startsWith(NOTEBOOK_CHAT_OBJECTIVE_PREFIX);
}

/** One conversation in a notebook: a chat run bound to its dossier, newest first. */
export type NotebookChat = {
  runId: string;
  state: string;
  createdAt: Date;
  endedAt: Date | null;
};

export async function listNotebookChats(auth: AuthContext, dossierId: string, limit = 20): Promise<NotebookChat[]> {
  return db
    .select({ runId: agentRuns.id, state: agentRuns.state, createdAt: agentRuns.createdAt, endedAt: agentRuns.endedAt })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, auth.workspaceId),
        sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "dossier", id: dossierId }])}::jsonb`,
        sql`${agentRuns.objective} like ${NOTEBOOK_CHAT_OBJECTIVE_PREFIX + "%"}`,
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}

/**
 * A conversation's label in the history: the first thing the person actually
 * asked. Every chat run's first user event is the (identical) objective, so
 * the label is the first follow-up; a conversation with none yet is "New
 * conversation". Reads the threads for the given runs in one query.
 */
export async function notebookChatLabels(workspaceId: string, runIds: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (runIds.length === 0) return labels;
  const threads = await listThreads(workspaceId, runIds);
  for (const runId of runIds) {
    const entries = threads.get(runId) ?? [];
    const followUp = entries.filter((entry) => entry.kind === "user")[1];
    const text = followUp?.text.trim();
    labels.set(runId, text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : "New conversation");
  }
  return labels;
}

/**
 * The last grounded answer a conversation produced, with the sources it
 * cited, for "Save to notes" (NotebookLM's save-to-note).
 *
 * The answer text is the thread's last assistant message. The citations are
 * recovered from the run's persisted tool calls with the same extraction rule
 * the live stream applies (stream-contract), so a reload shows the same
 * evidence the chat showed while it ran. A conversation that searched nothing
 * yields no citations, and the saved note honestly carries none.
 */
export type GroundedAnswer = { runId: string; answer: string; citations: DocumentCitation[] };

export async function lastGroundedAnswer(auth: AuthContext, runId: string): Promise<GroundedAnswer | null> {
  // listThreads is workspace-scoped, so a foreign or missing run answers null
  // here without a separate existence check.
  const threads = await listThreads(auth.workspaceId, [runId]);
  const entries = threads.get(runId) ?? [];
  const lastAssistant = [...entries].reverse().find((entry) => entry.kind === "assistant" && entry.text.trim() !== "");
  if (!lastAssistant) return null;

  const calls = await db
    .select({ result: toolCalls.result })
    .from(toolCalls)
    .where(and(eq(toolCalls.workspaceId, auth.workspaceId), eq(toolCalls.runId, runId), eq(toolCalls.ok, true)));
  const citations: DocumentCitation[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    for (const citation of citationsFromToolOutput(call.result)) {
      const key = `${citation.documentId}:${citation.span.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }
  return { runId, answer: lastAssistant.text, citations };
}
