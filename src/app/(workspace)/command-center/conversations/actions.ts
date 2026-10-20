"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createConversation } from "@/domains/conversations/commands";
import { syncThreadToGraph } from "@/domains/knowledge/thread-graph";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/* Conversations mutations. A thread starts with a title, an optional opening
 * message, or both - but not neither: an empty thread is a row no one can
 * find again. */

export async function createConversationAction(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z
    .object({
      title: z.string().trim().max(200).optional().default(""),
      openingMessage: z.string().trim().max(4000).optional().default(""),
    })
    .refine((v) => v.title.length > 0 || v.openingMessage.length > 0, {
      message: "Give the conversation a title or an opening message.",
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details and try again." };
  }
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const thread = await createConversation(auth, {
    title: parsed.data.title || null,
    openingMessage: parsed.data.openingMessage || null,
  });
  revalidatePath("/command-center/conversations");
  redirect(`/command-center/conversations/${thread.id}`);
}

/** Put the whole conversation in the knowledge graph (searchable, embedded, linkable) and open it there. */
export async function addConversationToKnowledgeAction(formData: FormData): Promise<void> {
  const threadId = z.string().uuid().parse(formData.get("threadId"));
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const { artifactId } = await syncThreadToGraph(auth, threadId);
  redirect(`/alfred/notebook?id=${artifactId}`);
}
