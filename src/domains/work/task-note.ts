import { createNoteInTx } from "@/domains/knowledge/notes";
import type { AuthContext } from "@/domains/identity/resolve";
import type { TxDrizzle } from "@/lib/db-transaction";

/*
 * A task's prose lives on its note, not on its row (one note substrate). Every
 * path that inserts a task creates the note here, in the caller's transaction,
 * so the task and the note it stands on commit together or not at all.
 *
 * The body is markdown ({format, text}), not ProseMirror doc JSON: the Notes
 * surface renders a note by reading content.text and returns "" otherwise, so a
 * doc-shaped body would open blank and the next autosave would overwrite it.
 * A missing or whitespace-only description keeps the empty doc createNoteInTx
 * writes for a fresh note - the same nothing the 0259 backfill stores.
 */
export async function createTaskNote(
  tx: TxDrizzle,
  auth: AuthContext,
  input: { title: string; description?: string | null },
): Promise<{ id: string; versionId: string }> {
  const text = input.description?.trim() ? input.description : null;
  return createNoteInTx(tx, auth, {
    title: input.title,
    template: "issue",
    ...(text ? { content: { format: "markdown", text }, plainText: text } : {}),
  });
}
