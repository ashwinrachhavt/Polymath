"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { retryRun, sendFollowUp } from "@/domains/agents/thread";

/*
 * Continuing the conversation.
 *
 * A live run takes the message directly. A finished run cannot — its session is
 * gone — so the message is first written into that run's history, where the
 * person put it, and a new run is started from it. The new run carries
 * `retryOfRunId`, so the chain of runs that make up one conversation is
 * reconstructable and the next render can follow it to the newest segment.
 *
 * This is what lets one conversation span several runs without the person ever
 * seeing run ids: "new chat" makes a fresh thread, and everything else continues
 * the one already open.
 */

type Result = { ok: true; runId: string; continued: boolean } | { ok: false; message: string };

const input = z.object({
  runId: z.string().uuid(),
  text: z.string().trim().min(1).max(8000),
});

export async function continueConversation(raw: unknown): Promise<Result> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Write a message first." };

  const auth = await getAuthContext();
  requireRole(auth, "member");

  const sent = await sendFollowUp(auth, parsed.data.runId, parsed.data.text);
  if (sent.ok) return { ok: true, runId: parsed.data.runId, continued: true };

  // A finished run is the ordinary case, not an error: start the next segment.
  if (sent.code === "run_finished") {
    const retried = await retryRun(auth, parsed.data.runId);
    if (!retried.ok) return { ok: false, message: retried.message };
    // The person's message belongs after the retry, so it is sent to the run
    // that will actually answer it rather than left in the old thread.
    const forwarded = await sendFollowUp(auth, retried.runId, parsed.data.text);
    if (!forwarded.ok) return { ok: false, message: forwarded.message };
    return { ok: true, runId: retried.runId, continued: false };
  }

  return { ok: false, message: sent.message };
}
