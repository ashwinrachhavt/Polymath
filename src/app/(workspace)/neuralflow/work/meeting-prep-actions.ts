"use server";

import { generateMeetingPrep, MeetingPrepNotAllowedError, MeetingPrepUnusableAnswerError } from "@/domains/knowledge/meeting-prep";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Meeting prep (ASH-302) entry point. The owner asks one event for a prep
 * report; the report is a knowledge artifact linked back to the event, so
 * regenerating before the meeting refreshes the link to the newest one.
 */

type Result = { ok: true; artifactId: string } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMeetingPrepAction(input: { eventId: string }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!UUID.test(input.eventId)) return { ok: false, error: "Malformed event id." };
  try {
    const result = await generateMeetingPrep(auth, input.eventId);
    // No revalidatePath: the Work route is dynamic (no cache to bust), no
    // server component renders the prep link (the row updates from this
    // result alone), and a revalidated action response carries a full route
    // re-render - under load that stream stalls the client's transition and
    // leaves the Refresh button disabled with no bound (ASH-322).
    return { ok: true, artifactId: result.artifactId };
  } catch (error) {
    if (error instanceof MeetingPrepNotAllowedError || error instanceof MeetingPrepUnusableAnswerError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The prep report did not run." };
  }
}
