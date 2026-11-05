"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { agentRuns } from "@/domains/agents/schema";
import { ThreadEmptyError, ThreadNotFoundError } from "@/domains/knowledge/thread-graph";
import { listLastMessageIds, zettelizeThread } from "@/domains/knowledge/thread-zettels";
import { db } from "@/lib/db";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import type { Result } from "@/lib/result";

/*
 * Zettelizing a conversation (plan Task 20). The client knows only the run it
 * is looking at, so the action resolves the thread server-side from the run —
 * the toolbar needs no new props and the chat surface does not grow. The
 * client mints the idempotency key; the server makes the thread artifact (or
 * reuses it) and runs the direct-creation pass — the extract click is the
 * acceptance, so real idea cards come out the other end. The
 * unread-character count rides back so the caller can say what was not read.
 */

const revalidate = () => revalidatePath("/polymath/[runId]", "page");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const zettelizeInput = z.object({
  runId: z.string().uuid(),
  /** This message, the last five, or the whole conversation. */
  scope: z.enum(["message", "last5", "thread"]),
  messageId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(),
});

export type ZettelizeThreadActionResult = Result<{ artifactId: string; created: number; unreadChars: number }>;

export async function zettelizeThreadAction(
  input: z.input<typeof zettelizeInput>,
): Promise<ZettelizeThreadActionResult> {
  const parsed = zettelizeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That request is not valid." };
  if (parsed.data.scope === "message" && !parsed.data.messageId) {
    return { ok: false, error: "That message is not available." };
  }
  const auth = await authorize();
  try {
    const [run] = await db
      .select({ threadId: agentRuns.threadId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, parsed.data.runId), eq(agentRuns.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!run?.threadId) return { ok: false, error: "This conversation is not available." };

    const messageIds =
      parsed.data.scope === "message"
        ? [parsed.data.messageId!]
        : parsed.data.scope === "last5"
          ? await listLastMessageIds(auth, run.threadId, 5)
          : undefined;
    const result = await zettelizeThread(auth, {
      threadId: run.threadId,
      messageIds,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    revalidate();
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ThreadNotFoundError) return { ok: false, error: "This conversation is not available." };
    if (error instanceof ThreadEmptyError)
      return { ok: false, error: "This conversation has no messages to read yet." };
    throw error;
  }
}
