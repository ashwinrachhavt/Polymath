import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { proposeTask } from "@/domains/work/proposals";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { proposeCard } from "./cards";
import { proposeNote } from "./note-proposals";
import { createNoteInTx } from "./notes";

/*
 * Learning paths (ASH-300): from a goal like "understand X," one pass
 * proposes the whole sequence - notes to read, practice tasks to do, recall
 * cards to drill - and nothing lands without the owner. Notes and tasks go
 * to the review queue as proposals; cards arrive in the proposed state the
 * cards screen already reviews, citing the path note as their source.
 *
 * The path itself is a real note (the sequence made visible), so the cards'
 * citations point at something the owner can open. Everything else waits.
 */

export class LearningPathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningPathNotAllowedError";
  }
}

export class LearningPathUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningPathUnusableAnswerError";
  }
}

export const LEARNING_PATH_MAX_NOTES = 5;
export const LEARNING_PATH_MAX_TASKS = 5;
export const LEARNING_PATH_MAX_CARDS = 10;

const response = z.object({
  pathTitle: z.string().trim().min(1).max(200),
  overview: z.string().trim().min(1).max(3000),
  notes: z.array(z.object({ title: z.string().trim().min(1).max(200), markdown: z.string().trim().min(1).max(10_000) })).max(LEARNING_PATH_MAX_NOTES).nullable(),
  practiceTasks: z.array(z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional() })).max(LEARNING_PATH_MAX_TASKS).nullable(),
  cards: z.array(z.object({ prompt: z.string().trim().min(1).max(500), answer: z.string().trim().min(1).max(2000) })).max(LEARNING_PATH_MAX_CARDS).nullable(),
});

export type LearningPathDraft = z.infer<typeof response>;

const SYSTEM = `You turn a learning goal into a sequence the owner can work through. Return JSON with exactly these keys: {"pathTitle": string, "overview": string, "notes": [{"title": string, "markdown": string}]|null, "practiceTasks": [{"title": string, "description"?: string}]|null, "cards": [{"prompt": string, "answer": string}]|null}.
"pathTitle": names the path, not just the goal.
"overview": the shape of the path in a few sentences - what order and why.
"notes": the reading sequence, foundations first; each markdown body teaches its step self-contained.
"practiceTasks": doing, not reading; each title an imperative.
"cards": recall prompts for what the path needs remembered; answers one or two sentences.
Return nulls rather than padding - a short real path beats a long padded one. ${untrustedDataClauseJsonSafe("learning goal")}`;

/** Parse the model's JSON strictly; a malformed or over-cap answer is unusable, never partially applied. */
export function parseLearningPathAnswer(text: string): LearningPathDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LearningPathUnusableAnswerError("The model's answer was not JSON.");
  }
  const parsed = response.safeParse(raw);
  if (!parsed.success) {
    throw new LearningPathUnusableAnswerError("The model's answer did not match the learning-path shape.");
  }
  const d = parsed.data;
  if (!d.notes?.length && !d.practiceTasks?.length && !d.cards?.length) {
    throw new LearningPathUnusableAnswerError("The model's answer was an empty path.");
  }
  return d;
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "goal";
}

function renderPathNote(draft: LearningPathDraft): string {
  const md: string[] = [`# ${draft.pathTitle}`, "", draft.overview, ""];
  if (draft.notes?.length) {
    md.push("## Reading sequence");
    draft.notes.forEach((n, i) => md.push(`${i + 1}. ${n.title}`));
    md.push("");
  }
  if (draft.practiceTasks?.length) {
    md.push("## Practice");
    for (const t of draft.practiceTasks) md.push(`- ${t.title}`);
    md.push("");
  }
  if (draft.cards?.length) {
    md.push("## Recall");
    for (const c of draft.cards) md.push(`- ${c.prompt}`);
    md.push("");
  }
  md.push("*The reading notes, practice tasks and recall cards are waiting as proposals - approve them to start the path.*");
  return md.join("\n");
}

export type LearningPathResult = {
  artifactId: string;
  noteProposalIds: string[];
  taskProposalIds: string[];
  cardIds: string[];
  deduplicated: number;
};

export async function generateLearningPath(
  auth: AuthContext,
  input: { goal: string },
  deps?: { provider?: GenerationProvider },
): Promise<LearningPathResult> {
  const goal = input.goal.trim();
  if (!goal) throw new LearningPathNotAllowedError("Name the learning goal.");

  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    if (error instanceof GenerationUnconfiguredError) throw new LearningPathNotAllowedError(error.message);
    throw error;
  }

  const out = await provider.generate({ system: SYSTEM, prompt: `GOAL: ${goal}`, json: true });
  const draft = parseLearningPathAnswer(out.text);

  // The path note exists before the proposals: the cards cite it, and the
  // owner can read the shape of the path while deciding the rest.
  const artifactId = await withTransaction(async (tx) => {
    const note = await createNoteInTx(tx, auth, { title: draft.pathTitle, kind: "note", plainText: renderPathNote(draft) });
    return note.id;
  });

  const batch = `learning-path:${slug(goal)}`;
  const noteProposalIds: string[] = [];
  const taskProposalIds: string[] = [];
  const cardIds: string[] = [];
  let deduplicated = 0;

  for (const [i, note] of (draft.notes ?? []).entries()) {
    const r = await proposeNote(auth, { title: note.title, markdown: note.markdown, dedupeKey: `${batch}:note:${i}:${slug(note.title)}` });
    if (r.deduplicated) deduplicated += 1;
    else noteProposalIds.push(r.proposalId);
  }
  for (const [i, task] of (draft.practiceTasks ?? []).entries()) {
    const r = await proposeTask(auth, {
      title: task.title,
      description: task.description,
      dedupeKey: `${batch}:task:${i}:${slug(task.title)}`,
    });
    if (r.deduplicated) deduplicated += 1;
    else taskProposalIds.push(r.proposalId);
  }
  for (const [i, card] of (draft.cards ?? []).entries()) {
    const r = await proposeCard(auth, {
      prompt: card.prompt,
      answer: card.answer,
      artifactId,
      idempotencyKey: `${batch}:card:${i}`,
    });
    cardIds.push(r.id);
  }

  await withTransaction(async (tx) => {
    await recordAudit(
      auth,
      {
        action: "learning.path_generated",
        subjectType: "artifact",
        subjectId: artifactId,
        summary: `Learning path "${draft.pathTitle}": ${noteProposalIds.length} notes, ${taskProposalIds.length} tasks, ${cardIds.length} cards proposed.`,
        metadata: { goal, noteProposalIds, taskProposalIds, cardIds, deduplicated, proposer: provider.name },
      },
      tx,
    );
  });

  return { artifactId, noteProposalIds, taskProposalIds, cardIds, deduplicated };
}
