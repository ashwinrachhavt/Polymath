import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { OnboardingConfirm } from "../../onboarding/onboarding-confirm";
import { OnboardingConversation } from "../../onboarding/onboarding-conversation";
import { OnboardingInterview } from "../../onboarding/onboarding-interview";
import { OnboardingStatusCard } from "../../onboarding/onboarding-status-card";

export const metadata = {
  title: "Onboarding fixtures",
  robots: { index: false, follow: false },
};

/*
 * Pixel fixture for the onboarding surfaces (ASH-296). The shared e2e
 * workspace is provisioned already-onboarded and no spec may flip that
 * marker, so the real /onboarding page can only ever show its gate redirect
 * in the harness. This route renders the same components, in the same
 * page-content wrapper the page uses, against fixture props - no database
 * marker moves, no Eve call, no spend. Development and CI only: a production
 * build answers 404.
 *
 * The `island` state is the one exception to "no Eve call": the conversation
 * island auto-starts its run on mount, which in the keyless harness fails
 * fast to the status card (EVE_BASE_URL unset) - the exact bridge-down
 * journey a first-run user hits on a runtime-less deployment.
 */

const FIXTURE_BRIEF: OnboardingBrief = {
  agentName: "Alfred",
  role: "Chief of staff for a solo founder",
  tools: ["Gmail", "Linear", "Google Calendar"],
  priorities: ["Keep the inbox at zero", "Never let a renewal surprise me"],
};

const SALVAGE_NOTICE =
  "The interview's summary could not be read, so the form below carries what could be salvaged from the conversation - correct it and continue.";

const BRIDGE_DOWN_REASON =
  "The agent runtime is not reachable from this deployment (EVE_BASE_URL is not set), so the interview cannot start.";

export default function OnboardingFixturesPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  // Production-inaccessibility is decided before any dynamic data loads.
  if (process.env.NODE_ENV === "production") notFound();
  // URL state under cacheComponents belongs inside a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <Fixture searchParams={searchParams} />
    </Suspense>
  );
}

async function Fixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state = "confirm" } = await searchParams;

  const wrapper = (child: React.ReactNode) => (
    <div className="page-content flex flex-1 items-center justify-center pt-16">{child}</div>
  );

  switch (state) {
    case "confirm":
      return wrapper(<OnboardingConfirm initial={FIXTURE_BRIEF} profileVersion={0} />);
    case "island":
      return wrapper(<OnboardingConversation />);
    /*
     * The successful-conversation state. The island's thread is Eve-backed in
     * production, so the e2e spec intercepts the run's stream endpoint and
     * replays fabricated ChatFrames - the REAL ChatSurface and accumulator
     * render the conversation, only the transport is staged. initialRunId
     * skips the start action; the brief poll misses silently.
     */
    case "island-success":
      return wrapper(<OnboardingConversation initialRunId="fixture-success-run" />);
    case "status":
      return wrapper(<OnboardingStatusCard reason={BRIDGE_DOWN_REASON} />);
    case "form":
      return wrapper(<OnboardingInterview />);
    case "form-salvage":
      return wrapper(
        <OnboardingInterview
          initial={{ agentName: "Alfred", role: "Chief of staff for a solo founder" }}
          notice={SALVAGE_NOTICE}
        />,
      );
    default:
      return notFound();
  }
}
