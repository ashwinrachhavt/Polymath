import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import type { DocumentCitation } from "./agent-search";
import { embedArtifact } from "./embedding";
import { artifactLinks } from "./schema";
import { createNoteInTx, type NoteContent } from "./notes";
import { saveAnswerAsNote } from "./save-answer";

/*
 * Save a chat message as a note or an idea (plan Task 10).
 *
 * Authorship is acceptance: saving a message as an idea is the owner's own
 * act, so it writes the artifact directly. Both saves
 * are idempotent under one key per save; a replayed key returns the first
 * save rather than minting a second.
 */

/** The idea title: the message's first sentence, capped at 120 characters. */
export function messageIdeaTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Saved idea";
  // The first period/exclamation/question that ends the sentence (not a
  // decimal point), up to 120 characters.
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const sentence = (match?.[0] ?? trimmed).trim();
  return sentence.slice(0, 120).trim() || "Saved idea";
}

/** The note body the editor writes for a saved message: one paragraph. */
function docFromText(text: string): NoteContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

export async function saveMessageAsNote(
  auth: AuthContext,
  input: { runId: string; title: string; text: string; citations: DocumentCitation[]; idempotencyKey: string },
): Promise<{ id: string }> {
  // saveAnswerAsNote already writes the note, the run `reference` edge, and
  // one `source` edge per cited document, under the same idempotency key.
  const note = await saveAnswerAsNote(auth, {
    runId: input.runId,
    title: input.title,
    answer: input.text,
    citations: input.citations,
    idempotencyKey: input.idempotencyKey,
  });
  return { id: note.id };
}

export async function saveMessageAsIdea(
  auth: AuthContext,
  input: { runId: string; title: string; text: string; idempotencyKey: string },
): Promise<{ id: string }> {
  const { value } = await withTransaction(async (tx) =>
    withReceipt(tx, auth, input.idempotencyKey, { op: "saveMessageAsIdea", ...input }, async () => {
      const idea = await createNoteInTx(tx, auth, {
        title: input.title,
        kind: "zettel",
        plainText: input.text,
        content: docFromText(input.text),
      });
      await tx
        .insert(artifactLinks)
        .values({
          workspaceId: auth.workspaceId,
          artifactId: idea.id,
          targetType: "run",
          targetId: input.runId,
          linkType: "source",
          label: "saved from an answer",
        })
        // The edge key is (artifact_id, target_type, target_id): a replayed
        // save re-inserts the same edge harmlessly.
        .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
      return { id: idea.id };
    }),
  );
  // Best-effort embed after commit: a failed embed never blocks the save.
  try {
    await embedArtifact(auth, { artifactId: value.id });
  } catch (cause) {
    console.error(
      `embedArtifact after saveMessageAsIdea failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return value;
}
