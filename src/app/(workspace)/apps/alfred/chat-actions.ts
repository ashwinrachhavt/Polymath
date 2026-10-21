"use server";

import { createEngine } from "@/domains/agents/engine";
import { createEveDriver, eveAgentForProfile, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { ensureProfile } from "@/domains/agents/commands";
import { getProfileByName } from "@/domains/agents/queries";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Starting a chat run from a surface.
 *
 * The chat surface is a client component, and `engine.start` needs a resolved
 * AuthContext plus a spend reservation, so the run must be created server-side.
 * This action is the one path every chat surface uses to get a runId; the
 * surface then streams from /api/v1/runs/:runId/stream.
 *
 * Idempotency is NOT implemented here. `engine.start` takes no key, and this
 * action claims no receipt, so two invocations start two runs. The surface
 * guards the common case by starting once per conversation, but a retry after a
 * timeout can still double-reserve. `profileName` and `estimateUsd` are fixed
 * rather than caller-supplied for the same reason the API route validates them:
 * an objective alone is the whole input a chat surface has.
 *
 * A failure returns a message the surface shows in place of a chat, rather than
 * throwing a stack into the boundary: "the agent is not configured" is a state,
 * not a crash.
 */

export type StartChatResult = { ok: true; runId: string } | { ok: false; message: string };

export async function startChatRun(input: {
  objective: string;
  /**
   * Omitted by the Assistant home, which starts a conversation before there is
   * a record to name. The run then carries `subjects: []`, the column's own
   * default — an invented subject with an empty id would be a false link.
   */
  subject?: { type: "dossier" | "document" | "artifact"; id: string };
  /** An enabled skill to pin the run to; the engine freezes it into the snapshot. */
  skillId?: string;
}): Promise<StartChatResult> {
  const objective = input.objective?.trim();
  if (!objective) return { ok: false, message: "Write a message first." };
  // A malformed id would reach Postgres's uuid cast and put raw database
  // error text in the composer; the API route validates the same shape.
  if (input.skillId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.skillId)) {
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

  const profileName = "alfred";
  await ensureProfile(auth.workspaceId, profileName);

  try {
    const engine = createEngine(createEveDriver(eveAgentForProfile(profileName)));
    const { runId } = await engine.start({
      auth,
      profileName,
      objective,
      subjects: input.subject ? [{ type: input.subject.type, id: input.subject.id }] : [],
      ...(input.skillId ? { skillId: input.skillId } : {}),
      estimateUsd: "0.50",
    });
    return { ok: true, runId };
  } catch (cause) {
    // The engine closes the run and returns budget on its own failure paths;
    // what is left is a start that never got a session.
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "The chat could not start.",
    };
  }
}

