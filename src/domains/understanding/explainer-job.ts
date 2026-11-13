import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure } from "@/domains/jobs/state";
import { resolveConceptIds } from "@/domains/knowledge/concepts";
import { createNoteInTx } from "@/domains/knowledge/notes";
import { artifacts, documentExtractions, documents } from "@/domains/knowledge/schema";
import { GENERATION_COPY, generateQuiz, QuizGenerationError } from "@/domains/learning/generate-quiz";
import { GenerationUnconfiguredError } from "@/integrations/generation/provider";
import {
  defaultExplainerGenerator,
  EXPLAINER_PROMPT_VERSION,
  type ExplainerGenerator,
} from "@/integrations/understanding/explainer-generator";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { composeExplainer, diffPaths, verifiedParts, type ExplainerParts } from "./explainer-format";
import { EXPLAINER_JOB_KIND } from "./job-names";
import { knownConcepts } from "./known";
import { getUnderstandingPreferences } from "./preferences";
import { codeExplainers } from "./schema";

/*
 * Writes an explainer: the note people open, the archived document that gives
 * the quiz its text, and the quiz. Each step records what it made on the
 * explainer row, so a retried job resumes where the last attempt stopped
 * instead of paying for the explanation twice.
 *
 * The document exists only because a quiz is made from a document's extraction
 * (the trust boundary that checks every question's quote against real text).
 * It is archived on creation so it never shows in the library; the note is the
 * thing the person sees.
 */

const inputSchema = z.object({ explainerId: z.uuid(), summary: z.string(), diff: z.string() });

/** The generator the runner uses; tests replace it with a deterministic one. */
export const explainerEngine: { make: (workspaceId: string) => ExplainerGenerator | Promise<ExplainerGenerator> } = {
  make: (workspaceId) => defaultExplainerGenerator(workspaceId),
};

const NO_MODEL_COPY =
  "This Polymath has no model configured, so it cannot write the explainer. Add a model key and try again.";

const makeExplainer: GenerationJobRunner = async (auth, raw, run) => {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed explainer job input");
  const input = parsed.data;

  const [explainer] = await db
    .select()
    .from(codeExplainers)
    .where(and(eq(codeExplainers.id, input.explainerId), eq(codeExplainers.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!explainer) throw new GenerationJobFailure("That explainer no longer exists.");

  let artifactId = explainer.artifactId;
  let documentId = explainer.documentId;
  if (!artifactId || !documentId) {
    await run.progress("Writing the explainer");
    const known = (await knownConcepts(auth))
      .filter((concept) => concept.level === "known")
      .map((concept) => concept.term);
    let generated;
    try {
      generated = await (
        await explainerEngine.make(auth.workspaceId)
      ).generate({
        repo: explainer.repo,
        commit: explainer.commitSha,
        summary: input.summary,
        diff: input.diff,
        knownConcepts: known,
      });
    } catch (cause) {
      if (cause instanceof GenerationUnconfiguredError) throw new GenerationJobFailure(NO_MODEL_COPY);
      throw cause;
    }
    const { parts, droppedRefs } = verifiedParts(generated, diffPaths(input.diff));
    ({ artifactId, documentId } = await writeExplainer(auth, explainer, parts, droppedRefs));
  }

  await run.progress("Writing the check");
  const preferences = await getUnderstandingPreferences(auth);
  try {
    const quiz = await generateQuiz(auth, {
      documentId,
      documentIds: [documentId],
      questionCount: preferences.questionCount,
      difficulty: preferences.difficulty,
      idempotencyKey: run.generationKey,
    });
    await db
      .update(codeExplainers)
      .set({ quizId: quiz.quizId, updatedAt: new Date() })
      .where(eq(codeExplainers.id, explainer.id));
  } catch (cause) {
    if (cause instanceof QuizGenerationError) throw new GenerationJobFailure(GENERATION_COPY[cause.code]);
    if (cause instanceof GenerationUnconfiguredError) throw new GenerationJobFailure(NO_MODEL_COPY);
    throw cause;
  }
  return { href: `/polymath/notes?id=${artifactId}`, notice: null };
};

async function writeExplainer(
  auth: Parameters<GenerationJobRunner>[0],
  explainer: typeof codeExplainers.$inferSelect,
  parts: ExplainerParts,
  droppedRefs: number,
): Promise<{ artifactId: string; documentId: string }> {
  const markdown = composeExplainer(parts, {
    repo: explainer.repo,
    commit: explainer.commitSha,
    range: explainer.range,
  });
  const contentHash = await sha256Hex(markdown);
  return withTransaction(async (tx) => {
    const note = await createNoteInTx(tx, auth, {
      title: parts.title.slice(0, 200),
      content: { format: "markdown", text: markdown },
      plainText: markdown,
    });
    const conceptIds = await resolveConceptIds(auth, parts.concepts, tx);
    await tx
      .update(artifacts)
      .set({
        tags: ["explainer", `repo:${explainer.repo}`, `commit:${explainer.commitSha.slice(0, 7)}`],
        metadata: {
          explainer: {
            explainerId: explainer.id,
            repo: explainer.repo,
            commit: explainer.commitSha,
            range: explainer.range,
            conceptIds: [...conceptIds.values()],
            promptVersion: EXPLAINER_PROMPT_VERSION,
          },
        },
      })
      .where(eq(artifacts.id, note.id));
    const [document] = await tx
      .insert(documents)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: note.id,
        title: `Explainer: ${parts.title}`.slice(0, 200),
        mimeType: "text/markdown",
        archivedAt: new Date(),
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: documents.id });
    await tx.insert(documentExtractions).values({
      workspaceId: auth.workspaceId,
      documentId: document.id,
      contentHash,
      status: "succeeded",
      text: markdown,
      spans: [{ page: 1, start: 0, end: markdown.length }],
      extractor: "polymath-explainer",
    });
    await tx
      .update(codeExplainers)
      .set({ artifactId: note.id, documentId: document.id, updatedAt: new Date() })
      .where(eq(codeExplainers.id, explainer.id));
    await recordAudit(
      auth,
      {
        action: "understanding.explainer_written",
        subjectType: "artifact",
        subjectId: note.id,
        summary: `Explained ${explainer.repo} at ${explainer.commitSha.slice(0, 7)}`,
        metadata: { explainerId: explainer.id, droppedRefs, concepts: parts.concepts.length },
      },
      tx,
    );
    return { artifactId: note.id, documentId: document.id };
  });
}

export const understandingJobRunners: Record<string, GenerationJobRunner> = {
  [EXPLAINER_JOB_KIND]: makeExplainer,
};
