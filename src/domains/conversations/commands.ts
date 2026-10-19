import { recordAudit } from "@/domains/audit/record";
import { ensureProfile } from "@/domains/agents/commands";
import { messages, threads } from "@/domains/agents/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";

/*
 * Conversation mutations (ASH-140 D04). Starting a thread is the only write
 * this slice owns: the row, its optional opening message, and the audit entry
 * land in one transaction, so a half-started thread cannot exist. The agent
 * profile comes from the engine's own ensureProfile - idempotent, so a first
 * conversation on a fresh workspace provisions the default profile instead of
 * failing on the foreign key.
 */

export async function createConversation(
  auth: AuthContext,
  input: { title: string | null; openingMessage: string | null },
) {
  const agentProfileId = await ensureProfile(auth.workspaceId);
  return withTransaction(async (tx) => {
    const [thread] = await tx
      .insert(threads)
      .values({
        workspaceId: auth.workspaceId,
        agentProfileId,
        title: input.title,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    if (input.openingMessage) {
      await tx.insert(messages).values({
        workspaceId: auth.workspaceId,
        threadId: thread.id,
        role: "user",
        content: input.openingMessage,
      });
    }
    await recordAudit(
      auth,
      {
        action: "conversation.created",
        subjectType: "thread",
        subjectId: thread.id,
        summary: input.title ? `Conversation started: ${input.title}` : "Conversation started",
      },
      tx,
    );
    return thread;
  });
}
