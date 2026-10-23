"use server";

import { z } from "zod";
import { createEveDriver, eveAgentForProfile, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { createEngine } from "@/domains/agents/engine";
import { ensureProfile } from "@/domains/agents/commands";
import { dossierDocumentIds } from "@/domains/knowledge/dossiers";
import { notebookChatObjective } from "@/domains/knowledge/notebook-chat";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Starts the grounded run for a notebook's chat pane.
 *
 * A server action, not a route: the chat surface is a client component and
 * cannot call AgentEngine.start itself (it needs an AuthContext and a spend
 * reservation). This is the server half; the surface owns streaming.
 *
 * The run is bound to the dossier through `subjects`, which is what restricts
 * documents.search to that notebook's sources. The dossier is checked for
 * membership before anything is spent.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export type StartNotebookRunResult = { ok: true; runId: string } | { ok: false; error: string };

export async function startNotebookRun(input: { dossierId: string; title: string }): Promise<StartNotebookRunResult> {
  const auth = await authorize();
  const parsed = z.object({ dossierId: z.uuid(), title: z.string().trim().min(1).max(200) }).parse(input);

  const documents = await dossierDocumentIds(auth, parsed.dossierId);
  if (documents === null) return { ok: false, error: "That notebook does not exist." };

  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return { ok: false, error: unavailable };

  try {
    await ensureProfile(auth.workspaceId, "alfred");
    const engine = createEngine(createEveDriver(eveAgentForProfile("alfred")));
    const { runId } = await engine.start({
      auth,
      profileName: "alfred",
      objective: notebookChatObjective(parsed.title),
      subjects: [{ type: "dossier", id: parsed.dossierId }],
      estimateUsd: "0.25",
    });
    return { ok: true, runId };
  } catch (cause) {
    // A failed start is a stated error, never a bare throw into the client.
    return { ok: false, error: cause instanceof Error ? cause.message : "The conversation could not be started." };
  }
}
