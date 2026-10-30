"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { agentQuestions } from "@/domains/agents/schema";
import { sendFollowUp } from "@/domains/agents/thread";

/*
 * Answering the question a run is suspended on.
 *
 * The row and the message travel together: the answer is what continues the
 * run, so a stored answer with a failed signal would leave the question closed
 * and the run stuck. The update is conditional on the question still being
 * open, which is the same guard a second tab needs — a stale card cannot answer
 * a question that was already answered.
 */

type Result = { ok: true } | { ok: false; message: string };

export async function answerRunQuestion(input: {
  runId: string;
  questionId: string;
  answer: string;
}): Promise<Result> {
  const parsed = z
    .object({
      runId: z.string().uuid(),
      questionId: z.string().uuid(),
      answer: z.string().trim().min(1).max(4000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: "Write an answer first." };

  const auth = await getAuthContext();
  requireRole(auth, "member");

  const [closed] = await db
    .update(agentQuestions)
    .set({
      state: "answered",
      answer: parsed.data.answer,
      answeredAt: new Date(),
      answeredBy: auth.userId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentQuestions.id, parsed.data.questionId),
        eq(agentQuestions.runId, parsed.data.runId),
        eq(agentQuestions.workspaceId, auth.workspaceId),
        eq(agentQuestions.state, "open"),
      ),
    )
    .returning({ id: agentQuestions.id });
  if (!closed) return { ok: false, message: "That question was already answered." };

  const sent = await sendFollowUp(auth, parsed.data.runId, parsed.data.answer);
  if (!sent.ok) {
    // The question is already closed, so the card offers no retry. Say what
    // happened and leave the conversation the way it is.
    revalidatePath(`/polymath/${parsed.data.runId}`);
    return { ok: false, message: sent.message };
  }

  revalidatePath(`/polymath/${parsed.data.runId}`);
  return { ok: true };
}
