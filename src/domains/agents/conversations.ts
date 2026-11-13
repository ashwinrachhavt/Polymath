/*
 * Conversations: the run rows the chat surface streams from under the
 * superagent pipeline.
 *
 * A conversation run is deliberately sessionless. Under the reactive path,
 * the chat surface's runId WAS the work: engine.start reserved spend and
 * opened the eve session in the same call. Under the pipeline, the run row
 * is only the durable transcript the Source reads — the Trigger names it as
 * its WorkThread, the assessor decides, and any actual work happens in the
 * ticket's own run, which reserves its own spend (agents/engine.ts). No
 * session here means no session to spend on: the conversation run reserves
 * nothing and starts nothing.
 *
 * The row is created in `waiting_input` — a conversation awaits a person's
 * next message by definition — and has no terminal state: it does not end
 * when a ticket run finishes, because the person can keep writing. History
 * reads it through the same thread reader every other surface uses
 * (listRecentRuns, toEntry), so it must look like a run row, which is why
 * the profile, revision, and model columns are populated the way start
 * would have.
 */
import { and, eq } from "drizzle-orm";
import { resolveRunModelFor } from "@/domains/billing/resolver";
import { recordRoundEvent } from "./event-bridge";
import { captureProfileRevision } from "./runtime-persistence";
import { agentProfiles, agentRuns } from "./schema";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";

/** The surface's record reference, the same shape the chat action validated before. */
export type ConversationSubject = { type: "project" | "document" | "artifact"; id: string };

export async function createConversationRun(input: {
  auth: AuthContext;
  profileName: string;
  /** The person's own words. Become the objective and the run's first event. */
  message: string;
  subjects?: ConversationSubject[];
}): Promise<{ runId: string; sequence: number }> {
  const [profile] = await db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, input.auth.workspaceId), eq(agentProfiles.name, input.profileName)))
    .limit(1);
  if (!profile) throw new Error(`Unknown agent profile: ${input.profileName}`);

  // Same discipline as engine.start: the revision is captured at creation so
  // the row reads consistently even though no session will consume it.
  const revision = await captureProfileRevision({ workspaceId: input.auth.workspaceId, profileId: profile.id });
  const model = await resolveRunModelFor(input.auth.workspaceId, profile.modelPolicy);

  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId: input.auth.workspaceId,
      createdBy: input.auth.userId,
      threadId: null,
      agentProfileId: profile.id,
      profileRevisionId: revision.id,
      objective: input.message,
      subjects: input.subjects ?? [],
      // Not `queued`: nothing is about to run. The conversation waits for a
      // person, which is exactly what waiting_input means in the state table.
      state: "waiting_input",
      policySnapshot: {
        profileId: profile.id,
        model,
        allowedTools: profile.allowedTools,
        allowedAccounts: profile.allowedAccounts,
        budgetUsd: profile.budgetPolicy,
        auth: input.auth,
      },
      model,
    })
    .returning({ id: agentRuns.id });

  // The person's words are the run's first event — the event the chat Source
  // turns into a Trigger. Written here, once, by the same writer every other
  // transcript row goes through. The message id is unique per send: identical
  // words in one conversation are two messages, and the event bridge's replay
  // dedupe must not collapse them into one.
  const written = await recordRoundEvent({
    runId: run.id,
    workspaceId: input.auth.workspaceId,
    type: "message",
    data: { role: "user", content: input.message, messageId: crypto.randomUUID() },
  });

  return { runId: run.id, sequence: written.sequence };
}
