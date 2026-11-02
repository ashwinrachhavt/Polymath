"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { IdempotencyConflictError } from "@/domains/audit/receipt";
import { saveMessageAsIdea, saveMessageAsNote, messageIdeaTitle } from "@/domains/knowledge/save-message";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Save a chat message as a note or an idea, from the message toolbar
 * (plan Task 10). Saving is the owner's own act of authorship: it writes
 * the artifact directly and never queues a proposal.
 */

const citation = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
  text: z.string().max(20_000),
  span: z.object({ start: z.number(), end: z.number(), page: z.number().int().nullable() }),
});

const saveNoteInput = z.object({
  runId: z.string().uuid(),
  // Optional: the toolbar sends only the text; the server derives the title.
  title: z.string().trim().max(200).optional(),
  text: z.string().min(1, "There is no answer to save.").max(200_000),
  citations: z.array(citation).max(20).default([]),
  idempotencyKey: z.string().uuid(),
});

const saveIdeaInput = z.object({
  runId: z.string().uuid(),
  title: z.string().trim().max(200).optional(),
  text: z.string().min(1, "There is no answer to save.").max(200_000),
  idempotencyKey: z.string().uuid(),
});

type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

/*
 * The only errors the save paths throw carry user-facing messages (an empty
 * answer, a reused key on a different payload). Anything else is a bug and
 * stays an unhandled server error rather than a leaked message.
 */
async function guarded<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return { ok: false, error: error.message };
    if (
      error instanceof Error &&
      (error.message === "There is no answer to save." || error.message.startsWith("There is already a note"))
    )
      return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveMessageAsNoteAction(input: z.input<typeof saveNoteInput>): Promise<Result<{ id: string }>> {
  const parsed = saveNoteInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That message cannot be saved." };
  const auth = await authorize();
  const payload = { ...parsed.data, title: parsed.data.title || messageIdeaTitle(parsed.data.text) };
  const result = await guarded(() => saveMessageAsNote(auth, payload));
  if (result.ok) revalidatePath(`/polymath/${parsed.data.runId}`);
  return result;
}

export async function saveMessageAsIdeaAction(input: z.input<typeof saveIdeaInput>): Promise<Result<{ id: string }>> {
  const parsed = saveIdeaInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That message cannot be saved." };
  const auth = await authorize();
  const payload = { ...parsed.data, title: parsed.data.title || messageIdeaTitle(parsed.data.text) };
  const result = await guarded(() => saveMessageAsIdea(auth, payload));
  if (result.ok) revalidatePath(`/polymath/${parsed.data.runId}`);
  return result;
}
