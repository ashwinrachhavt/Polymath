"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { syncThreadToGraph } from "@/domains/knowledge/thread-graph";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/** Put the whole conversation in the knowledge graph (searchable, embedded, linkable) and open it there. */
export async function addConversationToKnowledgeAction(formData: FormData): Promise<void> {
  const threadId = z.string().uuid().parse(formData.get("threadId"));
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const { artifactId } = await syncThreadToGraph(auth, threadId);
  redirect(`/polymath/notes?id=${artifactId}`);
}
