import { and, desc, eq, sql } from "drizzle-orm";
import type { AgentEngine } from "@/domains/agents/engine";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseForTransform } from "@/lib/prompts";
import { noteContentToMarkdown } from "./note-content";
import { commitNoteSnapshot, type NoteContent } from "./notes";
import { artifactLinks, artifactVersions, artifacts, workingDrafts } from "./schema";

/*
 * Notebook AI, in the register the owner asked for (Notion-AI-style, built
 * from observable public behaviour only): selection actions (improve, shorten,
 * summarize, translate) and "ask about this page" over the note and the
 * workspace's saved notes. Everything runs through the existing agent engine
 * as a run bound to the note, so spend, audit and history work the same way
 * they do for Studio Generate. The result is never written silently: the
 * owner reads it in a draft block and accepts (a committed version with run
 * lineage) or discards it.
 */

export const NOTE_AI_ACTIONS = ["improve", "shorten", "summarize", "translate", "ask"] as const;
export type NoteAIAction = (typeof NOTE_AI_ACTIONS)[number];

/** Objectives from this feature carry one marker so history and tests can tell them apart from other runs on the note. */
export const NOTE_AI_MARKER = "Notebook AI";

/** One size limit for whatever the model is handed, a selection or the note. */
export const MAX_NOTE_AI_CHARS = 8000;

export class NoteAIError extends Error {
  constructor(
    public readonly code:
      | "note_not_found"
      | "run_not_found"
      | "empty_input"
      | "too_long"
      | "no_output"
      | "run_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "NoteAIError";
  }
}

/** How much of the note a run read. Only "whole_note" may replace the note. */
export type NoteAICoverage = "selection" | "whole_note" | "note_start";

const REWRITE_ACTIONS: ReadonlySet<NoteAIAction> = new Set(["improve", "shorten", "translate"]);

/*
 * What the model will read, decided before any spend. A rewrite is refused
 * rather than run on part of its subject: its result can replace that subject,
 * and text the model never saw must not be replaceable. Summarize and ask only
 * read, so a long note is read from the top and the caller is told.
 */
export function resolveNoteAIScope(input: { action: NoteAIAction; noteMarkdown: string; selection?: string }): {
  subject: string;
  coverage: NoteAICoverage;
} {
  const selection = input.action === "ask" ? "" : (input.selection?.trim() ?? "");
  if (selection) {
    if (selection.length > MAX_NOTE_AI_CHARS) {
      throw new NoteAIError("too_long", "That selection is too long for one pass. Select a shorter passage.");
    }
    return { subject: selection, coverage: "selection" };
  }
  const note = input.noteMarkdown.trim();
  if (note.length <= MAX_NOTE_AI_CHARS) return { subject: note, coverage: "whole_note" };
  if (REWRITE_ACTIONS.has(input.action)) {
    throw new NoteAIError(
      "too_long",
      "This note is too long to rewrite in one pass. Select the part you want changed.",
    );
  }
  return {
    subject: `${note.slice(0, MAX_NOTE_AI_CHARS)}\n\n[…the note continues; this is the first ${MAX_NOTE_AI_CHARS} characters]`,
    coverage: "note_start",
  };
}

/**
 * Composes the run's objective. Pure, so the wording the feature stands on is
 * unit-tested instead of drifting inside an async body.
 */
export function buildNoteAIObjective(input: {
  action: NoteAIAction;
  noteTitle: string;
  noteMarkdown: string;
  selection?: string;
  question?: string;
  language?: string;
}): string {
  const { subject, coverage } = resolveNoteAIScope(input);
  const scope = coverage === "selection" ? "the selected passage" : "the note";
  const text = `${untrustedDataClauseForTransform("text below the line")}\n\n---\n${subject}`;
  switch (input.action) {
    case "improve":
      return `${NOTE_AI_MARKER}: improve the writing of ${scope} from the note "${input.noteTitle}". Fix grammar and tighten the prose; keep the author's voice, meaning and Markdown structure. Return only the revised text, with no preamble or commentary. ${text}`;
    case "shorten":
      return `${NOTE_AI_MARKER}: shorten ${scope} from the note "${input.noteTitle}". Aim for about half the length and keep the Markdown structure. Keep every fact, number, qualification, citation and commitment; when that needs more than half the length, keep the meaning over the length target. Return only the shortened text, with no preamble or commentary. ${text}`;
    case "summarize":
      return `${NOTE_AI_MARKER}: summarize ${scope} from the note "${input.noteTitle}". Answer with one short paragraph followed by bullet points of the key facts. Return only the summary, with no preamble or commentary. ${text}`;
    case "translate": {
      const language = input.language?.trim();
      return `${NOTE_AI_MARKER}: translate ${scope} from the note "${input.noteTitle}" into ${language}. Preserve the Markdown structure. Return only the translation, with no preamble or commentary. ${text}`;
    }
    case "ask": {
      const question = input.question?.trim();
      return `${NOTE_AI_MARKER}: answer a question about the note "${input.noteTitle}". Use the note first; when the question reaches beyond it, search the workspace's saved notes and use what you find. Answer plainly in Markdown, and cite every workspace note you rely on as a [[wiki-link]] by its exact title. If the note and the workspace do not contain the answer, say so instead of inventing one.\n\nQuestion: ${question}\n\n${text}`;
    }
  }
}

async function loadNote(auth: AuthContext, artifactId: string) {
  const [note] = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      content: artifactVersions.content,
      draftContent: workingDrafts.content,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    // Autosave writes the working draft, not a version: the draft is what the
    // editor shows, so it is what AI acts on. Without it a note that was typed
    // but never checkpointed read as empty.
    .leftJoin(
      workingDrafts,
      and(eq(workingDrafts.artifactId, artifacts.id), eq(workingDrafts.workspaceId, auth.workspaceId)),
    )
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")))
    .limit(1);
  if (!note) throw new NoteAIError("note_not_found", "No such note.");
  const markdown = noteContentToMarkdown((note.draftContent ?? note.content) as Record<string, unknown> | null);
  return { id: note.id, title: note.title, markdown };
}

/** Starts the run. Validates the action's inputs against the note before spending anything. */
export async function startNoteAIRun(
  auth: AuthContext,
  input: { artifactId: string; action: NoteAIAction; selection?: string; question?: string; language?: string },
  engine: AgentEngine,
) {
  const note = await loadNote(auth, input.artifactId);
  if (input.action === "ask" && !input.question?.trim()) throw new NoteAIError("empty_input", "Ask needs a question.");
  if (input.action === "translate" && !input.language?.trim())
    throw new NoteAIError("empty_input", "Translate needs a target language.");
  if (input.action !== "ask" && !input.selection?.trim() && !note.markdown.trim()) {
    throw new NoteAIError("empty_input", "The note is empty; there is nothing to work on.");
  }
  const objective = buildNoteAIObjective({
    action: input.action,
    noteTitle: note.title,
    noteMarkdown: note.markdown,
    selection: input.selection,
    question: input.question,
    language: input.language,
  });
  const { coverage } = resolveNoteAIScope({
    action: input.action,
    noteMarkdown: note.markdown,
    selection: input.selection,
  });
  const run = await engine.start({
    auth,
    profileName: "polymath",
    objective,
    subjects: [{ type: "note", id: note.id }],
    estimateUsd: "0.25",
  });
  return { ...run, coverage };
}

/** Recent Notebook AI runs on a note, newest first, with whatever output each has produced. */
export async function listNoteAIRuns(auth: AuthContext, artifactId: string, limit = 5) {
  const runs = await db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      objective: agentRuns.objective,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, auth.workspaceId),
        sql`${agentRuns.subjects} @> ${JSON.stringify([{ type: "note", id: artifactId }])}::jsonb`,
        sql`${agentRuns.objective} like ${NOTE_AI_MARKER + "%"}`,
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  return runs;
}

/** One run's state and its latest assistant output, if it has produced one yet. */
export async function getNoteAIRunOutput(auth: AuthContext, runId: string) {
  const [run] = await db
    .select({ id: agentRuns.id, state: agentRuns.state, objective: agentRuns.objective, subjects: agentRuns.subjects })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!run) throw new NoteAIError("run_not_found", "No such run.");
  const events = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.workspaceId, auth.workspaceId), eq(runEvents.type, "message")))
    .orderBy(desc(runEvents.sequence));
  const last = events
    .map((e) => e.data as { role?: string; content?: unknown })
    .find((d) => d?.role === "assistant" && typeof d.content === "string");
  return {
    runId: run.id,
    state: run.state,
    objective: run.objective,
    output: (last?.content as string | undefined) ?? null,
  };
}

/**
 * Accepts a run's result: commits the editor's new Markdown as the next
 * version under the usual CAS + receipt guards, then records the lineage
 * (note -> run link and audit entry). The commit replays under the receipt
 * key, so a retry after a lineage failure does not double-commit.
 */
export async function applyNoteAIResult(
  auth: AuthContext,
  input: {
    artifactId: string;
    runId: string;
    expectedVersion: number;
    content: NoteContent;
    plainText?: string;
    idempotencyKey?: string;
  },
) {
  const [run] = await db
    .select({ id: agentRuns.id, subjects: agentRuns.subjects })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!run) throw new NoteAIError("run_not_found", "No such run.");
  const bound = (Array.isArray(run.subjects) ? (run.subjects as Array<{ type?: string; id?: string }>) : []).some(
    (s) => s?.type === "note" && s?.id === input.artifactId,
  );
  if (!bound) throw new NoteAIError("run_mismatch", "That run was not started from this note.");

  const committed = await commitNoteSnapshot(auth, {
    artifactId: input.artifactId,
    expectedVersion: input.expectedVersion,
    content: input.content,
    plainText: input.plainText,
    note: "Applied an AI draft",
    idempotencyKey: input.idempotencyKey,
  });

  await withTransaction(async (tx) => {
    await tx
      .insert(artifactLinks)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: input.artifactId,
        targetType: "run",
        targetId: run.id,
        label: "ai draft applied",
      })
      .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
    await recordAudit(
      auth,
      {
        action: "note.ai.applied",
        subjectType: "artifact",
        subjectId: input.artifactId,
        summary: "Applied a Notebook AI draft",
      },
      tx,
    );
  });

  return committed;
}
