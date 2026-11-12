/*
 * How learning's generation jobs are named: their kinds and the subjects a
 * surface lists them by. No imports, so server code and client components
 * can both use it.
 */

export type LearningJobKind = "quiz" | "flashcards";

export const LEARNING_JOB_KIND_PREFIX = "learning.";

export function learningJobKind(kind: LearningJobKind): string {
  return LEARNING_JOB_KIND_PREFIX + kind;
}

/** The subject of jobs made for one Notebook, and of a document's own quiz. */
export const learningJobSubject = {
  notebook: (notebookId: string) => `notebook:${notebookId}`,
  document: (documentId: string) => `document:${documentId}`,
};
