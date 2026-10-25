"use server";

import { revalidatePath } from "next/cache";
import { draftFromLibrary, LibraryEmptyError, WritingUnusableAnswerError } from "@/domains/knowledge/library-writing";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Library-grounded drafts (ASH-301). The draft reads only the owner's
 * library and lands as a document artifact in the gallery; an empty library
 * is an honest refusal, shown where the owner asked.
 */

export async function draftFromLibraryAction(input: { topic: string }): Promise<{ ok: true; artifactId: string } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const topic = input.topic.trim().slice(0, 200);
  if (!topic) return { ok: false, error: "Name what the draft is about." };
  try {
    const result = await draftFromLibrary(auth, { topic });
    revalidatePath("/artifacts");
    return { ok: true, artifactId: result.artifactId };
  } catch (error) {
    if (error instanceof LibraryEmptyError || error instanceof WritingUnusableAnswerError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The draft did not run." };
  }
}
