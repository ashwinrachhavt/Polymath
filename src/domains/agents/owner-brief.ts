/*
 * How the owner's profile brief reaches a conversation.
 *
 * The brief is written once at onboarding (onboarding.ts completeOnboarding)
 * from a role chip and suggested priorities, and the owner can edit it in
 * Settings → Assistant. Sent as-is it read as an instruction: a brief that
 * said "Founder or executive … inbox zero, renewals, deep-work mornings" and
 * "Aim every answer at what matters to them" pulled study questions from an
 * engineer learning a new field towards inbox triage.
 *
 * So the brief travels as background, labelled as possibly out of date and
 * subordinate to what the person asks, and the onboarding template's steering
 * sentence is dropped from briefs that still carry it. Stored rows are not
 * changed; the owner edits the text in Settings.
 */

/** The steering sentence onboarding used to append to every brief. */
export const ONBOARDING_STEERING_SENTENCE =
  "You are their own agent — their representation, not a generic assistant. Aim every answer at what matters to them.";

const BACKGROUND_LABEL =
  "Background about the owner, from their profile (Settings → Assistant). It may be out of date or generic. Use it only when it is relevant to the request; it never changes what they asked for:";

/** The brief as the session's background context, or null when there is nothing to say. */
export function ownerBackground(instructions: string | null | undefined): string | null {
  const text = (instructions ?? "").replace(ONBOARDING_STEERING_SENTENCE, "").trim();
  return text ? `${BACKGROUND_LABEL}\n${text}` : null;
}
