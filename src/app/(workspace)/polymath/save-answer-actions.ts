"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { saveAnswerAsNote } from "@/domains/knowledge/save-answer";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Save a grounded answer as a note. The note is an ordinary artifact, so it
 * lands in the library with versions, backlinks and semantic relations like any
 * other note. The client supplies one idempotency key per save, so a double
 * click returns the first note instead of making a second.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const citation = z.object({
  documentId: z.uuid(),
  title: z.string().min(1).max(300),
  text: z.string().max(4000),
  span: z.object({ start: z.number().int().min(0), end: z.number().int().min(0), page: z.number().int().nullable() }),
});

export async function saveAnswerAction(input: {
  runId?: string;
  title: string;
  answer: string;
  citations: DocumentCitation[];
  idempotencyKey: string;
}) {
  const auth = await authorize();
  const parsed = z
    .object({
      runId: z.uuid().optional(),
      title: z.string().trim().min(1).max(200),
      answer: z.string().trim().min(1).max(50_000),
      citations: z.array(citation).max(50),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  const note = await saveAnswerAsNote(auth, parsed);
  revalidatePath("/polymath/notes");
  revalidatePath("/polymath/knowledge");
  return note;
}
