"use server";

import { revalidatePath } from "next/cache";
import { debriefMeetingArtifact, DebriefNotAllowedError, DebriefUnusableAnswerError } from "@/domains/knowledge/meeting-debrief";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The meeting-debrief entry point (ASH-303). The owner asks one artifact to
 * become a batch of review-queue proposals; nothing writes a task or note
 * until a proposal is approved in Reviews. A retry is safe: the batch's
 * dedupe keys resolve the proposals the first run already made.
 */

type Result = { ok: true; created: number; deduplicated: number } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function debriefArtifactAction(input: { artifactId: string }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!UUID.test(input.artifactId)) return { ok: false, error: "Malformed artifact id." };
  try {
    const result = await debriefMeetingArtifact(auth, input.artifactId);
    const created = result.taskProposalIds.length + result.noteProposalIds.length + result.followUpProposalIds.length;
    revalidatePath("/reviews");
    return { ok: true, created, deduplicated: result.deduplicated };
  } catch (error) {
    if (error instanceof DebriefNotAllowedError || error instanceof DebriefUnusableAnswerError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The debrief did not run." };
  }
}
