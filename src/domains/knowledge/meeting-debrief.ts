import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { artifacts, artifactVersions } from "./schema";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { proposeTask } from "@/domains/work/proposals";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { proposeNote } from "./note-proposals";

/*
 * Meeting debrief (ASH-303): one pass over a meeting transcript artifact
 * produces a single batch of review-queue proposals - tasks, notes, and
 * follow-ups - and nothing writes without the owner's approval.
 *
 * Follow-ups land as task proposals ("Follow up: ...") rather than calendar
 * proposals: the calendar follow-up kind is still on a branch, and a
 * follow-up is honest work as a to-do. Every item's dedupe key shares the
 * batch root `meeting-debrief:<artifactId>`, so a retried debrief resolves
 * the same proposals instead of doubling the queue.
 */

export class DebriefNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebriefNotAllowedError";
  }
}

export class DebriefUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebriefUnusableAnswerError";
  }
}

/** Model cap: a transcript longer than this is truncated, never rejected. */
export const DEBRIEF_MAX_INPUT_CHARS = 40_000;
export const DEBRIEF_MAX_TASKS = 10;
export const DEBRIEF_MAX_NOTES = 5;
export const DEBRIEF_MAX_FOLLOW_UPS = 10;

const response = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(2000).optional(),
        // ASH-279: an owner and a due date are what make a meeting task
        // actionable. Both are optional because a transcript often names
        // neither, and inventing either is worse than leaving it blank.
        owner: z.string().trim().max(120).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        /** The line in the transcript this came from, so the reviewer can check it. */
        quote: z.string().trim().max(400).optional(),
      }),
    )
    .max(DEBRIEF_MAX_TASKS)
    .nullable(),
  notes: z.array(z.object({ title: z.string().trim().min(1).max(200), markdown: z.string().trim().min(1).max(10_000) })).max(DEBRIEF_MAX_NOTES).nullable(),
  followUps: z
    .array(
      z.object({
        summary: z.string().trim().min(1).max(300),
        person: z.string().max(120).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .max(DEBRIEF_MAX_FOLLOW_UPS)
    .nullable(),
});

export type DebriefDraft = z.infer<typeof response>;

const SYSTEM = `You debrief a meeting transcript into follow-through for its owner. Return JSON with exactly these keys: {"tasks": [{"title": string, "description"?: string, "owner"?: string, "dueDate"?: string, "quote"?: string}]|null, "notes": [{"title": string, "markdown": string}]|null, "followUps": [{"summary": string, "person"?: string, "dueDate"?: string}]|null}.
"tasks": concrete to-dos the meeting assigned or implied; a title is an imperative verb phrase.
  "owner": the person the to-do belongs to, exactly as the transcript names them. Omit when the transcript does not say — never guess it is the workspace owner.
  "dueDate": YYYY-MM-DD, only when the transcript states or unambiguously implies one ("by Friday" from a dated meeting). Omit when it is vague; a wrong date is worse than no date.
  "quote": the sentence that assigned the task, verbatim, so the owner can check it. Keep it under 400 characters.
"notes": durable facts, decisions, or context worth keeping after the meeting; markdown bodies, decisions first.
"followUps": people the owner owes a reply or a nudge, with the person named when the transcript names them.
Skip anything already settled in the transcript. Return nulls rather than padding - an empty list the owner can add to beats proposals they must reject. ${untrustedDataClauseJsonSafe("transcript")} Debrief only what the transcript says.`;

export type DebriefResult = {
  /** The transcript's artifact, or null for a pasted transcript that was never saved. */
  artifactId: string | null;
  batchKey: string;
  taskProposalIds: string[];
  noteProposalIds: string[];
  followUpProposalIds: string[];
  deduplicated: number;
};

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "item";
}

/** Parse the model's JSON strictly; a malformed or over-cap answer is unusable, never partially applied. */
export function parseDebriefAnswer(text: string): DebriefDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DebriefUnusableAnswerError("The model's answer was not JSON.");
  }
  const parsed = response.safeParse(raw);
  if (!parsed.success) {
    throw new DebriefUnusableAnswerError("The model's answer did not match the debrief shape.");
  }
  return parsed.data;
}

export async function debriefMeetingArtifact(
  auth: AuthContext,
  artifactId: string,
  deps?: { provider?: GenerationProvider },
): Promise<DebriefResult> {
  const [row] = await db
    .select({ title: artifacts.title, kind: artifacts.kind, plainText: artifactVersions.plainText })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new DebriefNotAllowedError("That artifact does not exist in this workspace.");
  // Scoped to meeting transcripts (ASH-303): a generated note, report, or
  // learning path is not a meeting and must not be debriefed into one.
  if (row.kind !== "transcript") throw new DebriefNotAllowedError("Only a meeting transcript can be debriefed.");
  const transcript = (row.plainText ?? "").trim();
  if (!transcript) throw new DebriefNotAllowedError("This artifact has no text to debrief.");
  return debrief(auth, { transcript, title: row.title, batchRoot: `meeting-debrief:${artifactId}`, artifactId }, deps);
}

/**
 * ASH-279: debrief a transcript the owner pasted into the conversation, before
 * it is saved anywhere. Same batch semantics, keyed on a caller-supplied stable
 * key instead of an artifact id, so a retried debrief of the same paste
 * resolves the same proposals.
 */
export async function debriefPastedTranscript(
  auth: AuthContext,
  input: { transcript: string; title?: string; batchKey: string },
  deps?: { provider?: GenerationProvider },
): Promise<DebriefResult> {
  const transcript = input.transcript.trim();
  if (!transcript) throw new DebriefNotAllowedError("There is no transcript to read.");
  return debrief(
    auth,
    {
      transcript,
      title: input.title?.trim() || "Pasted transcript",
      batchRoot: `meeting-paste:${input.batchKey}`,
      artifactId: null,
    },
    deps,
  );
}

async function debrief(
  auth: AuthContext,
  source: { transcript: string; title: string; batchRoot: string; artifactId: string | null },
  deps?: { provider?: GenerationProvider },
): Promise<DebriefResult> {
  const { transcript, title, batchRoot, artifactId } = source;

  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    // No key configured is a clear refusal, not a failure: the owner sees why
    // the debrief cannot run, and nothing is proposed.
    if (error instanceof GenerationUnconfiguredError) throw new DebriefNotAllowedError(error.message);
    throw error;
  }

  const out = await provider.generate({
    system: SYSTEM,
    prompt: transcript.slice(0, DEBRIEF_MAX_INPUT_CHARS),
    json: true,
  });
  const draft = parseDebriefAnswer(out.text);

  const batchKey = batchRoot;
  const taskProposalIds: string[] = [];
  const noteProposalIds: string[] = [];
  const followUpProposalIds: string[] = [];
  let deduplicated = 0;

  for (const [i, task] of (draft.tasks ?? []).entries()) {
    // The owner and the quote are review context, not task fields: they go in
    // the description so the approver sees who was named and what was actually
    // said before creating the task. A due date IS a task field.
    const description = [task.description, task.owner ? `Owner: ${task.owner}` : null, task.quote ? `From the transcript: “${task.quote}”` : null]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const r = await proposeTask(auth, {
      title: task.title,
      ...(description ? { description } : {}),
      ...(task.dueDate ? { dueAt: `${task.dueDate}T17:00:00.000Z` } : {}),
      dedupeKey: `${batchKey}:task:${i}:${slug(task.title)}`,
    });
    if (r.deduplicated) deduplicated += 1;
    else taskProposalIds.push(r.proposalId);
  }
  for (const [i, note] of (draft.notes ?? []).entries()) {
    const r = await proposeNote(auth, {
      title: note.title,
      markdown: note.markdown,
      dedupeKey: `${batchKey}:note:${i}:${slug(note.title)}`,
    });
    if (r.deduplicated) deduplicated += 1;
    else noteProposalIds.push(r.proposalId);
  }
  for (const [i, followUp] of (draft.followUps ?? []).entries()) {
    const title = followUp.person ? `Follow up with ${followUp.person}: ${followUp.summary}` : `Follow up: ${followUp.summary}`;
    const r = await proposeTask(auth, {
      title: title.slice(0, 200),
      description: "Proposed by the meeting debrief; schedule it when you approve.",
      ...(followUp.dueDate ? { dueAt: `${followUp.dueDate}T17:00:00.000Z` } : {}),
      dedupeKey: `${batchKey}:followup:${i}:${slug(followUp.summary)}`,
    });
    if (r.deduplicated) deduplicated += 1;
    else followUpProposalIds.push(r.proposalId);
  }

  const created = taskProposalIds.length + noteProposalIds.length + followUpProposalIds.length;
  await withTransaction(async (tx) => {
    await recordAudit(
      auth,
      {
        action: "meeting.debriefed",
        // A pasted transcript has no artifact to hang the audit on, so it is
        // recorded against the batch itself rather than a null subject.
        subjectType: artifactId ? "artifact" : "meeting_paste",
        subjectId: artifactId ?? batchKey,
        summary: `Debriefed "${title}" into ${created} proposal${created === 1 ? "" : "s"}.`,
        metadata: {
          batchKey,
          taskProposalIds,
          noteProposalIds,
          followUpProposalIds,
          deduplicated,
          proposer: provider.name,
        },
      },
      tx,
    );
  });

  return { artifactId, batchKey, taskProposalIds, noteProposalIds, followUpProposalIds, deduplicated };
}
