import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { recordAudit } from "@/domains/audit/record";
import type { DocumentCitation } from "./agent-search";
import { artifactLinks } from "./schema";
import { createNote } from "./notes";

/*
 * Save a grounded answer as a note (NotebookLM's "save to note").
 *
 * The note is a normal artifact, so it inherits the whole library: versions,
 * wiki links, backlinks, semantic relations. The answer keeps its sources as
 * labels plus a link edge per document, so the saved note can still answer
 * "where did this come from" a month later.
 *
 * Idempotent under one key per save. Saving the same run's answer twice with
 * the same key returns the first note rather than minting a second.
 */

export type SaveAnswerInput = {
  /** The run the answer came from, when there is one. */
  runId?: string;
  title: string;
  answer: string;
  citations: DocumentCitation[];
  idempotencyKey: string;
};

/** The note body: the answer, then a numbered source list. */
export function answerToMarkdown(answer: string, citations: DocumentCitation[]): string {
  const sources = citations
    .map((c, i) => `${i + 1}. ${c.title}${c.span.page !== null ? ` (p. ${c.span.page})` : ""}`)
    .join("\n");
  return sources ? `${answer.trim()}\n\n---\n\nSources\n${sources}` : answer.trim();
}

export async function saveAnswerAsNote(auth: AuthContext, input: SaveAnswerInput) {
  const title = input.title.trim().slice(0, 200) || "Saved answer";
  const text = answerToMarkdown(input.answer, input.citations);
  if (!text.trim()) throw new Error("There is no answer to save.");

  const note = await createNote(auth, {
    title,
    plainText: text,
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    idempotencyKey: input.idempotencyKey,
  });

  // Link the note to what it came from. Both writes are idempotent, and they
  // run after the note commits so a link failure never loses the note.
  await withTransaction(async (tx) => {
    if (input.runId) {
      await tx
        .insert(artifactLinks)
        .values({ workspaceId: auth.workspaceId, artifactId: note.id, targetType: "run", targetId: input.runId, label: "answer saved from" })
        .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
    }
    for (const citation of input.citations) {
      await tx
        .insert(artifactLinks)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: note.id,
          targetType: "document",
          targetId: citation.documentId,
          linkType: "source",
          label: citation.title.slice(0, 200),
          context: citation.text.slice(0, 500),
        })
        .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
    }
    await recordAudit(
      auth,
      {
        action: "note.saved_from_answer",
        subjectType: "artifact",
        subjectId: note.id,
        summary: `Saved an answer as "${title}"`,
        metadata: { runId: input.runId ?? null, citations: input.citations.length },
      },
      tx,
    );
  });

  return note;
}
