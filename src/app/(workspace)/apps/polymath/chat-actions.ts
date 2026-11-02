"use server";

import { ensureProfile } from "@/domains/agents/commands";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { startSuperagentConversation } from "@/domains/superagent/wiring";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { fitMentionContext } from "@/components/chat/mention-context";

/*
 * Starting a chat conversation from a surface — the superagent cutover.
 *
 * The chat surface is a client component and needs a server-side runId to
 * stream; this action is the one path every chat surface uses to get one.
 * Under the cutover the run is the conversation's durable transcript (a
 * sessionless row the person's words seed), and the message travels through
 * the superagent pipeline: the chat Source translates it into a Trigger, the
 * policy gate and assessor decide it, and any admitted work runs in the
 * ticket's own run, whose reply returns through the outbox into this
 * conversation's stream. No session opens on the conversation row itself —
 * nothing answers a person here except the pipeline.
 *
 * The objective bound matches the smallest documented cap in
 * src/app/api/v1/runs: the POST route validates `objective` at 2000
 * (continueConversation allows 8000, the follow-up message route 4000). The
 * bound is enforced by shedding context blocks, never the typed text — see
 * fitMentionContext.
 *
 * A failure returns a message the surface shows in place of a chat, rather
 * than throwing a stack into the boundary: "the agent is not configured" is
 * a state, not a crash.
 */

/** The smallest documented objective cap in src/app/api/v1/runs (POST route). */
const MAX_OBJECTIVE_CHARS = 2000;

export type StartChatResult = { ok: true; runId: string } | { ok: false; message: string };

export async function startChatRun(input: {
  objective: string;
  /**
   * Omitted by the Assistant home, which starts a conversation before there is
   * a record to name. The run then carries `subjects: []`, the column's own
   * default — an invented subject with an empty id would be a false link.
   */
  subject?: { type: "project" | "document" | "artifact"; id: string };
  /** An enabled skill to pin the run to; the engine freezes it into the snapshot. */
  skillId?: string;
}): Promise<StartChatResult> {
  const objective = input.objective?.trim();
  if (!objective) return { ok: false, message: "Write a message first." };
  // Shed context blocks over the cap; the typed words are never cut.
  const bounded = fitMentionContext(objective, MAX_OBJECTIVE_CHARS);
  // A malformed id would reach Postgres's uuid cast and put raw database
  // error text in the composer; the API route validates the same shape.
  if (
    input.skillId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.skillId)
  ) {
    return { ok: false, message: "That skill could not be found. Pick it from the list again." };
  }

  let auth;
  try {
    auth = await getAuthContext();
    requireRole(auth, "member");
  } catch {
    return { ok: false, message: "Sign in to start a chat." };
  }

  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return { ok: false, message: unavailable };

  const profileName = "polymath";
  await ensureProfile(auth.workspaceId, profileName);

  try {
    // The skill pin is a reactive-path concept: a conversation run under the
    // pipeline carries the person's words and the pipeline's decisions, and
    // any work runs in the ticket's own run. A skill picked in the composer
    // is recorded in the trigger's text, not frozen into a snapshot that no
    // session will ever read.
    if (input.skillId) {
      console.warn("[superagent] chat send ignored a skill pin; skills bind to ticket runs (wave two).");
    }
    const { runId } = await startSuperagentConversation({
      auth,
      profileName,
      message: bounded,
      ...(input.subject ? { subjects: [{ type: input.subject.type, id: input.subject.id }] } : {}),
    });
    return { ok: true, runId };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The chat could not start.",
    };
  }
}
