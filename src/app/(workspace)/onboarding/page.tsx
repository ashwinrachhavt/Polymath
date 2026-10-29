import { io } from "next/cache";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth";
import {
  findLatestOnboardingRun,
  findLiveOnboardingRun,
  isWorkspaceOnboarded,
  readOnboardingRun,
} from "@/domains/agents/onboarding";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { OnboardingConversation } from "./onboarding-conversation";
import { OnboardingStatusCard } from "./onboarding-status-card";
import { OnboardingConfirm } from "./onboarding-confirm";
import { OnboardingInterview } from "./onboarding-interview";

export const metadata = { title: "Meet your agent · Polymath" };

/*
 * First-run onboarding: one short conversation with the workspace's future
 * agent, then an editable confirm card, then the commit path every onboarding
 * shares (completeOnboarding). The form component survives as the
 * extraction-failure fallback, not as the front door.
 *
 * The page is the reload anchor. It re-derives where the flow stands from the
 * database on every load — an open interview run resumes, a finished run with
 * a valid brief goes straight to the card, a finished run without one falls
 * to the pre-filled form — so no client state is ever load-bearing.
 */
async function OnboardingSurface() {
  await io();
  const auth = await getAuthContext();
  if (await isWorkspaceOnboarded(auth.workspaceId)) {
    redirect("/polymath");
  }

  // A hard block, not a form: without the runtime there is no agent to
  // personify, and collecting a brief for one would be a lie about what
  // this deployment is.
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) {
    return (
      <div className="page-content flex flex-1 items-center justify-center pt-16">
        <OnboardingStatusCard reason={unavailable} />
      </div>
    );
  }

  // An open interview resumes on the same run — continue signals it, never a
  // second run. Its thread may already carry the brief (the final turn landed
  // while the tab was away); then the card renders immediately.
  const live = await findLiveOnboardingRun(auth.workspaceId);
  if (live) {
    const reading = await readOnboardingRun(auth, live.id);
    if (reading?.brief) {
      return (
        <div className="page-content flex flex-1 items-center justify-center pt-16">
          <OnboardingConfirm initial={reading.brief} profileVersion={reading.profileVersion} />
        </div>
      );
    }
    return (
      <div className="page-content flex flex-1 items-center justify-center pt-16">
        <OnboardingConversation initialRunId={live.id} />
      </div>
    );
  }

  // A finished interview the person never confirmed: the brief (or the
  // salvageable pieces of it) still leads. A run that failed or closed
  // without a parseable payload routes to the form pre-filled from the
  // thread — extraction failure can never brick onboarding.
  const latest = await findLatestOnboardingRun(auth.workspaceId);
  if (latest) {
    const reading = await readOnboardingRun(auth, latest.id);
    if (reading?.brief) {
      return (
        <div className="page-content flex flex-1 items-center justify-center pt-16">
          <OnboardingConfirm initial={reading.brief} profileVersion={reading.profileVersion} />
        </div>
      );
    }
    if (reading && Object.keys(reading.prefill).length > 0) {
      return (
        <div className="page-content flex flex-1 items-center justify-center pt-16">
          <OnboardingInterview
            initial={reading.prefill}
            notice="We couldn't read the interview's summary cleanly. What's salvageable is pre-filled — correct it and continue."
          />
        </div>
      );
    }
  }

  return (
    <div className="page-content flex flex-1 items-center justify-center pt-16">
      <OnboardingConversation />
    </div>
  );
}

/*
 * `connection()` and the auth resolve must sit inside a Suspense boundary
 * under cacheComponents, or navigation treats them as uncached data.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading…</p>}>
      <OnboardingSurface />
    </Suspense>
  );
}
