"use server";

import { ensureProfile } from "@/domains/agents/commands";
import { createEngine } from "@/domains/agents/engine";
import { createEveDriver, eveAgentForProfile, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { fitMentionContext } from "@/components/chat/mention-context";

/*
 * Starts a normal interactive Eve run for the main chat. Eve owns the model
 * loop and transcript; the Superagent ticket pipeline remains available for
 * already admitted background work and its review surface.
 */

/** The smallest documented objective cap in src/app/api/v1/runs (POST route). */
const MAX_OBJECTIVE_CHARS = 2000;

export type StartChatResult = { ok: true; runId: string } | { ok: false; message: string };

export async function startChatRun(input: {
  objective: string;
  subject?: { type: "project" | "document" | "artifact"; id: string };
  skillId?: string;
}): Promise<StartChatResult> {
  const objective = input.objective?.trim();
  if (!objective) return { ok: false, message: "Write a message first." };
  const bounded = fitMentionContext(objective, MAX_OBJECTIVE_CHARS);
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
  try {
    await ensureProfile(auth.workspaceId, profileName);
    const { runId } = await createEngine(createEveDriver(eveAgentForProfile(profileName))).start({
      auth,
      profileName,
      objective: bounded,
      subjects: input.subject ? [input.subject] : [],
      estimateUsd: "0.50",
      skillId: input.skillId,
    });
    return { ok: true, runId };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The chat could not start.",
    };
  }
}
