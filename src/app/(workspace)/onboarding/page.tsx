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
import { resolveReloadSurface } from "./reload-surface";

export const metadata = { title: "Meet your agent · Polymath" };

// Every branch renders its surface in the same centered wrapper; named once
// so the page reads as a decision, not as a stack of identical divs.
const surfaceWrap = (node: React.ReactNode) => (
  <div className="page-content flex flex-1 items-center justify-center pt-16">{node}</div>
);

/*
 * First-run onboarding: one short conversation with the workspace's future
 * agent, then an editable confirm card, then the commit path every onboarding
 * shares (completeOnboarding). The form component survives as the
 * extraction-failure fallback, not as the front door.
 *
 * The page is the reload anchor. It re-derives where the flow stands from the
 * database on every load — an open interview run resumes, a finished run with
 * a valid brief goes straight to the card, a failed run lands on its failure
 * card or the pre-filled form (never an auto-start) — so no client state is
 * ever load-bearing.
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
    return surfaceWrap(<OnboardingStatusCard reason={unavailable} />);
  }

  // An open interview resumes on the same run — continue signals it, never a
  // second run. Its thread may already carry the brief (the final turn landed
  // while the tab was away); then the card renders immediately.
  const live = await findLiveOnboardingRun(auth.workspaceId);
  if (live) {
    const reading = await readOnboardingRun(auth, live.id);
    if (reading?.brief) {
      return surfaceWrap(<OnboardingConfirm initial={reading.brief} profileVersion={reading.profileVersion} />);
    }
    return surfaceWrap(<OnboardingConversation initialRunId={live.id} />);
  }

  // A finished interview the person never confirmed: the brief (or the
  // salvageable pieces of it) still leads. A failed run never auto-restarts
  // (F5): what it captured routes to the form, and a failed run with nothing
  // salvageable lands on the failure card, whose Retry makes the next run
  // explicit — a reload can no longer mint run rows, sessions, and spend
  // reservations behind the reader's back.
  const latest = await findLatestOnboardingRun(auth.workspaceId);
  if (latest) {
    const surface = resolveReloadSurface(latest, await readOnboardingRun(auth, latest.id));
    if (surface.kind === "confirm") {
      return surfaceWrap(<OnboardingConfirm initial={surface.brief} profileVersion={surface.profileVersion} />);
    }
    if (surface.kind === "interview") {
      return surfaceWrap(<OnboardingInterview initial={surface.prefill} notice={surface.notice} />);
    }
    if (surface.kind === "retry") {
      return surfaceWrap(<OnboardingConversation initialError={surface.message} />);
    }
  }

  return surfaceWrap(<OnboardingConversation />);
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
