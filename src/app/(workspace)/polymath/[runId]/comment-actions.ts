"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MessageCommentError, addMessageComment, resolveMessageComment } from "@/domains/agents/message-comments";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { bindGuarded, type Result } from "@/lib/result";

/*
 * Message comments on a conversation (plan Task 9). The same shape the note
 * comments use — Result<T>, a guarded domain-error mapping, an idempotency
 * key the client mints — pointed at the run page instead of the note.
 */

const revalidate = () => revalidatePath("/polymath/[runId]", "page");

/*
 * Comment writes require member or above, the same floor the note comments
 * sit behind. The domain applies the ASH-306 supervisor-thread rule on top.
 */
async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const guarded = bindGuarded({ domainErrors: [MessageCommentError], onSuccess: revalidate });

const key = z.string().uuid();

const addCommentInput = z.object({
  messageId: z.string().uuid(),
  body: z.string().trim().min(1, "Write a comment first.").max(2000, "Comments hold up to 2000 characters."),
  idempotencyKey: key,
});

export type PanelComment = {
  id: string;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  authorName: string | null;
};

export async function addMessageCommentAction(
  input: z.input<typeof addCommentInput>,
): Promise<Result<{ comment: PanelComment }>> {
  const parsed = addCommentInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That comment is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    const comment = await addMessageComment(auth, parsed.data);
    return {
      comment: {
        id: comment.id,
        body: comment.body,
        resolvedAt: comment.resolvedAt ? comment.resolvedAt.toISOString() : null,
        createdAt: comment.createdAt.toISOString(),
        authorName: comment.authorName,
      },
    };
  });
}

const resolveCommentInput = z.object({
  commentId: z.string().uuid(),
  resolved: z.boolean(),
  idempotencyKey: key,
});

export async function resolveMessageCommentAction(
  input: z.input<typeof resolveCommentInput>,
): Promise<Result<{ resolvedAt: string | null }>> {
  const parsed = resolveCommentInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That comment reference is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    const { resolvedAt } = await resolveMessageComment(auth, parsed.data);
    return { resolvedAt: resolvedAt ? resolvedAt.toISOString() : null };
  });
}
